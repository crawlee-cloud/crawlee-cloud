/**
 * Job queue for processing Actor runs.
 * 
 * Uses PostgreSQL for durability and Redis for notifications.
 */

import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { executeRun, buildActorEnv } from './docker.js';

const { Pool } = pg;

interface RunJob {
  id: string;
  actor_id: string;
  status: string;
  default_dataset_id: string;
  default_key_value_store_id: string;
  default_request_queue_id: string;
  timeout_secs: number;
  memory_mbytes: number;
}

interface ActorRow {
  id: string;
  name: string;
  default_run_options: { image?: string } | null;
}

let pool: pg.Pool;
let redis: Redis;
let isProcessing = false;
let activeRuns = 0;

/**
 * Initialize job queue connections.
 */
export async function initJobQueue(): Promise<void> {
  pool = new Pool({
    connectionString: config.databaseUrl,
  });
  
  redis = new Redis(config.redisUrl);
  
  // Subscribe to run notifications
  const subscriber = new Redis(config.redisUrl);
  await subscriber.subscribe('run:new');
  
  subscriber.on('message', (_channel, message) => {
    console.log(`New run notification: ${message}`);
    processNextRun();
  });
  
  console.log('Job queue initialized');
}

/**
 * Main processing loop.
 */
export async function startProcessing(): Promise<void> {
  console.log('Starting run processor...');
  
  // Process any pending runs on startup
  while (true) {
    await processNextRun();
    await sleep(1000); // Check every second
  }
}

/**
 * Process the next pending run.
 */
async function processNextRun(): Promise<void> {
  if (isProcessing || activeRuns >= config.maxConcurrentRuns) {
    return;
  }
  
  isProcessing = true;
  
  try {
    // Get next pending run (FIFO)
    const result = await pool.query<RunJob>(`
      SELECT * FROM runs 
      WHERE status = 'READY' 
      ORDER BY created_at ASC 
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    
    if (!result.rows[0]) {
      return; // No pending runs
    }
    
    const run = result.rows[0];
    console.log(`Processing run ${run.id}`);
    
    // Update status to RUNNING
    await pool.query(`
      UPDATE runs SET status = 'RUNNING', started_at = NOW(), modified_at = NOW() 
      WHERE id = $1
    `, [run.id]);
    
    activeRuns++;
    
    // Process in background
    processRun(run).finally(() => {
      activeRuns--;
    });
    
  } finally {
    isProcessing = false;
  }
}

/**
 * Process a single run.
 */
async function processRun(run: RunJob): Promise<void> {
  const runId = run.id;
  
  try {
    // Get actor details
    const actorResult = await pool.query<ActorRow>(
      'SELECT * FROM actors WHERE id = $1',
      [run.actor_id]
    );
    
    if (!actorResult.rows[0]) {
      throw new Error(`Actor not found: ${run.actor_id}`);
    }
    
    const actor = actorResult.rows[0];
    const image = actor.default_run_options?.image || `crawlee-cloud/actor-${actor.name}:latest`;
    
    // Build environment variables
    const env = buildActorEnv({
      runId: run.id,
      actorId: run.actor_id,
      apiBaseUrl: config.apiBaseUrl,
      token: config.apiToken,
      defaultDatasetId: run.default_dataset_id,
      defaultKeyValueStoreId: run.default_key_value_store_id,
      defaultRequestQueueId: run.default_request_queue_id,
      memoryMbytes: run.memory_mbytes,
      timeoutSecs: run.timeout_secs,
    });
    
    // Execute container
    const result = await executeRun({
      runId: run.id,
      actorId: run.actor_id,
      image,
      env,
      memoryMb: run.memory_mbytes,
      timeoutSecs: run.timeout_secs,
    });
    
    // Determine final status
    let status: string;
    if (result.exitCode === 0) {
      status = 'SUCCEEDED';
    } else if (result.exitCode === 143) {
      status = 'TIMED-OUT';
    } else {
      status = 'FAILED';
    }
    
    // Update run record
    await pool.query(`
      UPDATE runs 
      SET status = $1, finished_at = $2, modified_at = NOW()
      WHERE id = $3
    `, [status, result.finishedAt, runId]);
    
    console.log(`Run ${runId} completed with status: ${status}`);
    
    // Trigger webhooks
    await triggerWebhooks(runId, status);
    
  } catch (err) {
    console.error(`Run ${runId} failed with error:`, err);
    
    await pool.query(`
      UPDATE runs 
      SET status = 'FAILED', status_message = $1, finished_at = NOW(), modified_at = NOW()
      WHERE id = $2
    `, [(err as Error).message, runId]);
    
    await triggerWebhooks(runId, 'FAILED');
  }
}

/**
 * Trigger webhooks for run events.
 */
async function triggerWebhooks(runId: string, status: string): Promise<void> {
  const eventType = `ACTOR.RUN.${status}`;
  
  // Get applicable webhooks
  const webhooks = await pool.query<{ id: string; request_url: string; payload_template: string | null }>(`
    SELECT * FROM webhooks 
    WHERE is_enabled = true AND $1 = ANY(event_types)
  `, [eventType]);
  
  if (webhooks.rows.length === 0) {
    return;
  }
  
  // Get run details
  const runResult = await pool.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
  const run = runResult.rows[0];
  
  // Trigger each webhook
  for (const webhook of webhooks.rows) {
    try {
      const payload = webhook.payload_template 
        ? JSON.parse(webhook.payload_template.replace(/\{\{([^}]+)\}\}/g, (_match: string, key: string): string => {
            const value = (run as Record<string, unknown>)[key];
            return value !== undefined ? String(value) : '';
          }))
        : {
            eventType,
            eventData: {
              actorId: run.actor_id,
              actorRunId: runId,
              status,
            },
            createdAt: new Date().toISOString(),
          };
      
      console.log(`Triggering webhook ${webhook.id} to ${webhook.request_url}`);
      
      await fetch(webhook.request_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error(`Webhook ${webhook.id} failed:`, err);
    }
  }
}

/**
 * Notify about new run.
 */
export async function notifyNewRun(runId: string): Promise<void> {
  await redis.publish('run:new', runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
