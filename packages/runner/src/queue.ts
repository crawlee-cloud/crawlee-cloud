/**
 * Job queue for processing Actor runs.
 *
 * Uses PostgreSQL for durability and Redis for notifications.
 */

import pg from 'pg';
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { executeRun, buildActorEnv } from './docker.js';
import { applyWebhookTemplate } from './webhook-template.js';

const { Pool } = pg;

interface RunJob {
  id: string;
  actor_id: string;
  user_id: string;
  status: string;
  default_dataset_id: string;
  default_key_value_store_id: string;
  default_request_queue_id: string;
  timeout_secs: number;
  memory_mbytes: number;
  retry_count: number;
  origin_run_id: string | null;
  run_after: Date | null;
  // Optional: present on rows fetched after a run has progressed.
  // attemptWebhookDelivery uses these to build the Apify-compatible
  // resource block — null means "not yet" (e.g. run still RUNNING).
  started_at?: Date | null;
  finished_at?: Date | null;
  exit_code?: number | null;
  build_id?: string | null;
  build_number?: string | null;
  stats_json?: {
    inputBodyLen?: number;
    restartCount?: number;
    resurrectCount?: number;
    runTimeSecs?: number;
    computeUnits?: number;
  } | null;
}

interface ActorRow {
  id: string;
  name: string;
  default_run_options: {
    image?: string;
    envVars?: Record<string, string>;
  } | null;
}

const RUNNER_API_KEY_REDIS_KEY = 'runner:api-key';

let pool: pg.Pool;
let redis: Redis;
let isProcessing = false;
let activeRuns = 0;
let shuttingDown = false;
let runnerApiKey: string | null = null;
const activeRunIds = new Set<string>();

export function stopProcessing(): void {
  shuttingDown = true;
}

export function getActiveRunCount(): number {
  return activeRuns;
}

export function getActiveRunIds(): string[] {
  return [...activeRunIds];
}

/**
 * Initialize job queue connections.
 */
export async function initJobQueue(): Promise<void> {
  pool = new Pool({
    connectionString: config.databaseUrl,
  });

  redis = new Redis(config.redisUrl);

  // Fetch runner API key from Redis (created by API's setupAdminUser)
  runnerApiKey = await redis.get(RUNNER_API_KEY_REDIS_KEY);
  if (runnerApiKey) {
    console.log('Runner API key loaded from Redis');
  } else {
    console.warn(
      'WARNING: No runner API key found in Redis. Actor containers will fail to authenticate.'
    );
    console.warn('Make sure the API server has started and created the runner key.');
  }

  // Subscribe to run notifications
  const subscriber = new Redis(config.redisUrl);
  await subscriber.subscribe('run:new');

  subscriber.on('message', (_channel, message) => {
    console.log(`New run notification: ${message}`);
    void processNextRun();
  });

  console.log('Job queue initialized');
}

/**
 * Main processing loop.
 */
export async function startProcessing(): Promise<void> {
  console.log('Starting run processor...');

  // Start webhook retry processor (every 10 seconds)
  void (async () => {
    while (!shuttingDown) {
      await processWebhookRetries();
      await sleep(10_000);
    }
  })();

  while (!shuttingDown) {
    await processNextRun();
    await sleep(1000);
  }
}

/**
 * Process the next pending run.
 */
async function processNextRun(): Promise<void> {
  if (shuttingDown || isProcessing || activeRuns >= config.maxConcurrentRuns) {
    return;
  }

  isProcessing = true;

  try {
    // Get next pending run (FIFO), respecting delayed retries
    const result = await pool.query<RunJob>(`
      SELECT * FROM runs
      WHERE status = 'READY' AND (run_after IS NULL OR run_after <= NOW())
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
    await pool.query(
      `
      UPDATE runs SET status = 'RUNNING', started_at = NOW(), modified_at = NOW() 
      WHERE id = $1
    `,
      [run.id]
    );

    activeRuns++;
    activeRunIds.add(run.id);

    // Process in background
    void processRun(run).finally(() => {
      activeRuns--;
      activeRunIds.delete(run.id);
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
    const actorResult = await pool.query<ActorRow>('SELECT * FROM actors WHERE id = $1', [
      run.actor_id,
    ]);

    if (!actorResult.rows[0]) {
      throw new Error(`Actor not found: ${run.actor_id}`);
    }

    const actor = actorResult.rows[0];
    const actorEnvVars = actor.default_run_options?.envVars ?? {};

    // Resolve image: actor config → registry → local convention
    let image: string;
    if (actor.default_run_options?.image) {
      image = actor.default_run_options.image;
    } else if (config.imageRegistry) {
      // Pull from configured registry. The `actor-` prefix matches what
      // `crc push` writes (see cli/src/commands/push.ts) — both the local
      // (`crawlee-cloud/actor-NAME`) and GHCR (`ghcr.io/REPO/actor-NAME`)
      // push paths use it. Without the prefix here, runners would 404 on
      // every pull from a configured registry.
      image = `${config.imageRegistry}/actor-${actor.name}:latest`;
    } else {
      // Local convention
      image = `crawlee-cloud/actor-${actor.name}:latest`;
    }

    // Fetch runtime env vars from Redis (set by CLI -e flag)
    const runtimeEnvVarsJson = await redis.get(`run:${run.id}:envVars`);
    const runtimeEnvVars = runtimeEnvVarsJson
      ? (JSON.parse(runtimeEnvVarsJson) as unknown as Record<string, string>)
      : {};

    // Resolve token: prefer runner API key from Redis, fall back to config
    const token = runnerApiKey ?? config.apiToken;
    if (!runnerApiKey) {
      // Try fetching again in case the API created it after we started
      runnerApiKey = await redis.get(RUNNER_API_KEY_REDIS_KEY);
    }

    // Build environment variables
    const baseEnv = buildActorEnv({
      runId: run.id,
      actorId: run.actor_id,
      apiBaseUrl: config.apiBaseUrl,
      token: runnerApiKey ?? token,
      defaultDatasetId: run.default_dataset_id,
      defaultKeyValueStoreId: run.default_key_value_store_id,
      defaultRequestQueueId: run.default_request_queue_id,
      memoryMbytes: run.memory_mbytes,
      timeoutSecs: run.timeout_secs,
    });

    // Merge: base env < actor env (from actor.json) < runtime env (from -e flag)
    const env = { ...baseEnv, ...actorEnvVars, ...runtimeEnvVars };

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

    // Update run record. Persist exit_code alongside status so receivers
    // reading the webhook payload (resource.exitCode) and the runs API see
    // the real exit value rather than null.
    //
    // The `WHERE status = 'RUNNING'` guard is the lifecycle invariant: if
    // the actor SDK called Actor.fail() (PUT /v2/actor-runs/:id with
    // status=FAILED) while the container was alive, the run is already in
    // a terminal state and we MUST NOT overwrite it from the container's
    // exit code. Common scenario: actor catches its own error, calls
    // Actor.fail(), the SDK then cleans up and the process exits 0 — the
    // pre-fix code would have flipped the run back to SUCCEEDED, hiding
    // the failure on the dashboard, in webhooks, and in the runs API.
    //
    // RETURNING to detect the no-op case so we can log it (operator
    // signal that some other path won the race — usually Actor.fail()).
    const updateResult = await pool.query<{ status: string }>(
      `
      UPDATE runs
      SET status = $1, finished_at = $2, exit_code = $3, modified_at = NOW()
      WHERE id = $4 AND status = 'RUNNING'
      RETURNING status
    `,
      [status, result.finishedAt, result.exitCode, runId]
    );

    if (updateResult.rowCount === 0) {
      // Status was already terminal — re-read what's there so the rest of
      // the function (webhooks, retry) sees the authoritative status.
      const cur = await pool.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [
        runId,
      ]);
      const winning = cur.rows[0]?.status ?? status;
      console.log(
        `Run ${runId} container exited ${String(result.exitCode)} but run was already ${winning} (kept that). Likely Actor.fail() or abort.`
      );
      status = winning;
    } else {
      console.log(`Run ${runId} completed with status: ${status}`);
    }

    // Ingest Crawlee stats (SDK_CRAWLER_STATISTICS_0 from the run's KV
    // store) so resource.stats in the webhook payload and the runs API
    // carry real numbers instead of zero placeholders. Quiet no-op when
    // the file isn't there (actor crashed before crawler.run()).
    await ingestCrawlerStats(runId);

    // Trigger webhooks
    await triggerWebhooks(runId, status);

    if (status === 'FAILED') {
      await maybeRetryRun(run, runId);
    }
  } catch (err) {
    console.error(`Run ${runId} failed with error:`, err);

    // Same `WHERE status = 'RUNNING'` guard as the success path: if the
    // run reached a terminal state via another path (Actor.fail() →
    // PUT /v2/actor-runs/:id, or POST /v2/actor-runs/:id/abort) while
    // we were processing, we MUST NOT overwrite that status with
    // 'FAILED'. Common scenario: operator aborts → container is killed
    // → kill signal surfaces here as a thrown error → without this
    // guard, the run flips ABORTED → FAILED, hiding the operator
    // intent on the dashboard, in webhooks, and in the runs API.
    const updateResult = await pool.query<{ status: string }>(
      `
      UPDATE runs
      SET status = 'FAILED', status_message = $1, finished_at = NOW(), modified_at = NOW()
      WHERE id = $2 AND status = 'RUNNING'
      RETURNING status
    `,
      [(err as Error).message, runId]
    );

    let webhookStatus = 'FAILED';
    if (updateResult.rowCount === 0) {
      // Terminal status was already set elsewhere — re-read so we fire
      // the right ACTOR.RUN.* event (e.g. ABORTED, not FAILED).
      const cur = await pool.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [
        runId,
      ]);
      webhookStatus = cur.rows[0]?.status ?? 'FAILED';
      console.log(
        `Run ${runId} caught error but run was already ${webhookStatus} (kept that). Likely Actor.fail() or abort.`
      );
    }

    await triggerWebhooks(runId, webhookStatus);
    if (webhookStatus === 'FAILED') {
      await maybeRetryRun(run, runId);
    }
  }
}

/**
 * The runner's own URL for calling the API. config.apiBaseUrl is what we
 * inject into actor *containers* (translated to host.docker.internal on
 * macOS). For the runner process itself (running on the host), the
 * `host.docker.internal` form doesn't resolve back — collapse it to
 * `localhost`. Linux deploys typically have the API reachable at the same
 * URL from runner and actor, so this is a no-op there.
 */
function selfApiBaseUrl(): string {
  return config.apiBaseUrl.replace(/(^https?:\/\/)host\.docker\.internal(:|\/|$)/, '$1localhost$2');
}

/**
 * After a run completes, fetch SDK_CRAWLER_STATISTICS_0 from the run's KV
 * store via the API's ingest endpoint and stamp the parsed stats onto
 * runs.stats_json. This is what makes webhook payload's resource.stats
 * carry real Crawlee numbers (requestsFinished, requestsFailed, errors,
 * crawlerRuntimeMillis) instead of zero placeholders.
 *
 * Best-effort: any failure is logged and swallowed — webhook delivery
 * must not be blocked by stats ingestion. The endpoint itself returns 200
 * with `stats: null` when the SDK file is absent (actor crashed before
 * crawler.run()), which is the common case.
 */
async function ingestCrawlerStats(runId: string): Promise<void> {
  if (!runnerApiKey) return;
  try {
    const url = `${selfApiBaseUrl()}/v2/actor-runs/${runId}/ingest-crawler-stats`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runnerApiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(`[stats] ingest endpoint returned HTTP ${String(response.status)} for ${runId}`);
    }
  } catch (err) {
    console.warn(`[stats] ingest failed for ${runId}: ${(err as Error).message}`);
  }
}

/**
 * Trigger webhooks for run events.
 * Creates delivery records and attempts immediate delivery.
 */
async function triggerWebhooks(runId: string, status: string): Promise<void> {
  // Apify convention: status string uses HYPHEN ('TIMED-OUT') but event
  // type uses UNDERSCORE ('ACTOR.RUN.TIMED_OUT'). Translate at this seam
  // so the rest of the codebase carries Apify-canonical status strings
  // while webhook receivers (apify-client and other external consumers)
  // get the canonical event-type form.
  const eventType = `ACTOR.RUN.${status.replace(/-/g, '_')}`;

  // Get run details for payload
  const runResult = await pool.query<RunJob>('SELECT * FROM runs WHERE id = $1', [runId]);
  const run = runResult.rows[0];
  if (!run) return;

  // Get applicable webhooks (global OR scoped to this actor)
  const webhooks = await pool.query<{
    id: string;
    request_url: string;
    payload_template: string | null;
    headers: Record<string, string> | null;
    actor_id: string | null;
  }>(
    `SELECT * FROM webhooks
     WHERE is_enabled = true AND $1 = ANY(event_types)
       AND (actor_id IS NULL OR actor_id = $2)
       AND (run_id IS NULL OR run_id = $3)`,
    [eventType, run.actor_id, runId]
  );

  if (webhooks.rows.length === 0) return;

  for (const webhook of webhooks.rows) {
    const deliveryId = nanoid();

    // Create delivery record. next_retry_at MUST be NULL on insert — we
    // call attemptWebhookDelivery synchronously below for the first try.
    // If we set next_retry_at = NOW() here, processWebhookRetries (running
    // in parallel every 10s) sees this PENDING row as eligible for retry
    // and fires a duplicate POST before our immediate attempt finishes the
    // UPDATE. Net effect was 2-3 webhook.site receives per run, only one
    // delivery row in the DB (UPDATEs raced and overwrote attempt_count).
    // scheduleRetry sets next_retry_at forward only on actual failures.
    await pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, run_id, event_type, status, attempt_count, max_attempts, next_retry_at)
       VALUES ($1, $2, $3, $4, 'PENDING', 0, 5, NULL)`,
      [deliveryId, webhook.id, runId, eventType]
    );

    // Attempt immediate delivery
    await attemptWebhookDelivery(deliveryId, webhook, run, eventType);
  }
}

/**
 * Schedule a retry run if the actor's retry policy allows it.
 */
async function maybeRetryRun(run: RunJob, runId: string): Promise<void> {
  try {
    const actorResult = await pool.query<{
      max_retries: number;
      retry_delay_secs: number;
    }>('SELECT max_retries, retry_delay_secs FROM actors WHERE id = $1', [run.actor_id]);

    const actor = actorResult.rows[0];
    if (!actor || actor.max_retries <= 0) return;
    if (run.retry_count >= actor.max_retries) return;

    const newRunId = nanoid();
    const originRunId = run.origin_run_id ?? runId;
    const newRetryCount = run.retry_count + 1;

    console.log(
      `Scheduling retry ${newRetryCount}/${actor.max_retries} for run ${runId} as ${newRunId}`
    );

    await pool.query(
      `INSERT INTO runs (id, actor_id, user_id, status, default_dataset_id, default_key_value_store_id,
        default_request_queue_id, timeout_secs, memory_mbytes, retry_count, origin_run_id, run_after)
       VALUES ($1, $2, (SELECT user_id FROM runs WHERE id = $3), 'READY',
        $4, $5, $6, $7, $8, $9, $10,
        NOW() + INTERVAL '1 second' * $11)`,
      [
        newRunId,
        run.actor_id,
        runId,
        run.default_dataset_id,
        run.default_key_value_store_id,
        run.default_request_queue_id,
        run.timeout_secs,
        run.memory_mbytes,
        newRetryCount,
        originRunId,
        actor.retry_delay_secs,
      ]
    );

    await redis.publish('run:new', newRunId);
  } catch (err) {
    console.error(`Failed to schedule retry for run ${runId}:`, err);
  }
}

/**
 * Check if a URL targets a private/internal network address.
 * Blocks RFC 1918, link-local, loopback, and metadata endpoints.
 */
function isPrivateUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true; // Invalid URLs are blocked
  }

  const hostname = parsed.hostname;

  // Block loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Block link-local / cloud metadata (169.254.x.x)
  if (hostname.startsWith('169.254.')) {
    return true;
  }

  // Block RFC 1918 private ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    const [a, b] = parts as [number, number, number, number];
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 0.0.0.0
    if (parts.every((p) => p === 0)) return true;
  }

  return false;
}

/**
 * Attempt a single webhook delivery.
 */
async function attemptWebhookDelivery(
  deliveryId: string,
  webhook: {
    id: string;
    request_url: string;
    payload_template: string | null;
    headers: Record<string, string> | null;
  },
  run: RunJob,
  eventType: string
): Promise<void> {
  const RETRY_DELAYS = [10, 30, 60, 300, 900]; // seconds

  try {
    // Default Apify-compatible payload. KEEP IN SYNC with
    // packages/api/src/routes/webhooks.ts → buildWebhookPayload — the
    // test endpoint mirrors this shape so receivers tested with one
    // path don't break in production. The webhook test snapshot in
    // webhooks.test.ts locks the contract.
    //
    // The user's optional payload_template is then applied via the
    // shared two-pass engine, which gives Apify-style typed splicing
    // (`"{{eventData}}"` becomes the object, not the literal string)
    // against this camelCase payload — not the snake_case run row.
    const defaultPayload = {
      userId: run.user_id,
      createdAt: new Date().toISOString(),
      eventType,
      eventData: { actorId: run.actor_id, actorRunId: run.id },
      resource: {
        id: run.id,
        actId: run.actor_id,
        userId: run.user_id,
        usageTotalUsd: 0, // Apify-shape parity; Crawlee Cloud has no usage tracking yet
        status: run.status,
        startedAt: run.started_at?.toISOString() ?? null,
        finishedAt: run.finished_at?.toISOString() ?? null,
        defaultDatasetId: run.default_dataset_id,
        defaultKeyValueStoreId: run.default_key_value_store_id,
        defaultRequestQueueId: run.default_request_queue_id,
        options: { timeoutSecs: run.timeout_secs, memoryMbytes: run.memory_mbytes },
        buildId: run.build_id ?? null,
        buildNumber: run.build_number ?? null,
        exitCode: run.exit_code ?? null,
        stats: {
          inputBodyLen: run.stats_json?.inputBodyLen ?? 0,
          restartCount: run.stats_json?.restartCount ?? 0,
          resurrectCount: run.stats_json?.resurrectCount ?? 0,
          runTimeSecs:
            run.stats_json?.runTimeSecs ??
            (run.finished_at && run.started_at
              ? Math.round(
                  (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000
                )
              : 0),
          computeUnits: run.stats_json?.computeUnits ?? 0,
        },
      },
    };
    const payload = applyWebhookTemplate(webhook.payload_template, defaultPayload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(webhook.headers ?? {}),
    };

    console.log(`Delivering webhook ${webhook.id} to ${webhook.request_url}`);

    if (isPrivateUrl(webhook.request_url)) {
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'FAILED', attempt_count = attempt_count + 1,
             response_body = 'Webhook URL targets a private/internal network address',
             finished_at = NOW(), next_retry_at = NULL
         WHERE id = $1`,
        [deliveryId]
      );
      return;
    }

    const response = await fetch(webhook.request_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      // Success
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'DELIVERED', attempt_count = attempt_count + 1,
             response_status = $1, response_body = $2,
             finished_at = NOW(), next_retry_at = NULL
         WHERE id = $3`,
        [response.status, responseBody.slice(0, 1024), deliveryId]
      );
    } else {
      // HTTP error — schedule retry
      await scheduleRetry(deliveryId, response.status, responseBody.slice(0, 1024), RETRY_DELAYS);
    }
  } catch (err) {
    // Network error — schedule retry
    await scheduleRetry(deliveryId, null, (err as Error).message.slice(0, 1024), RETRY_DELAYS);
  }
}

/**
 * Schedule a retry with exponential backoff, or mark as failed if max attempts reached.
 */
async function scheduleRetry(
  deliveryId: string,
  responseStatus: number | null,
  responseBody: string,
  retryDelays: number[]
): Promise<void> {
  // Get current attempt count
  const delivery = await pool.query<{ attempt_count: number; max_attempts: number }>(
    'SELECT attempt_count, max_attempts FROM webhook_deliveries WHERE id = $1',
    [deliveryId]
  );

  if (!delivery.rows[0]) return;

  const newAttempt = delivery.rows[0].attempt_count + 1;

  if (newAttempt >= delivery.rows[0].max_attempts) {
    // Max retries exhausted
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'FAILED', attempt_count = $1,
           response_status = $2, response_body = $3,
           finished_at = NOW(), next_retry_at = NULL
       WHERE id = $4`,
      [newAttempt, responseStatus, responseBody, deliveryId]
    );
  } else {
    // Schedule next retry
    const delaySecs = retryDelays[newAttempt - 1] ?? retryDelays[retryDelays.length - 1]!;
    await pool.query(
      `UPDATE webhook_deliveries
       SET attempt_count = $1, response_status = $2, response_body = $3,
           next_retry_at = NOW() + INTERVAL '1 second' * $4
       WHERE id = $5`,
      [newAttempt, responseStatus, responseBody, delaySecs, deliveryId]
    );
  }
}

/**
 * Process pending webhook delivery retries.
 * Runs on a 10-second interval.
 */
async function processWebhookRetries(): Promise<void> {
  try {
    const pending = await pool.query<{
      id: string;
      webhook_id: string;
      run_id: string;
      event_type: string;
    }>(
      `SELECT wd.id, wd.webhook_id, wd.run_id, wd.event_type
       FROM webhook_deliveries wd
       WHERE wd.status = 'PENDING' AND wd.next_retry_at <= NOW()
       LIMIT 10
       FOR UPDATE SKIP LOCKED`
    );

    for (const delivery of pending.rows) {
      const webhook = await pool.query<{
        id: string;
        request_url: string;
        payload_template: string | null;
        headers: Record<string, string> | null;
      }>('SELECT * FROM webhooks WHERE id = $1', [delivery.webhook_id]);

      if (!webhook.rows[0]) {
        // Webhook deleted — mark delivery as failed
        await pool.query(
          `UPDATE webhook_deliveries SET status = 'FAILED', finished_at = NOW(), next_retry_at = NULL WHERE id = $1`,
          [delivery.id]
        );
        continue;
      }

      const run = await pool.query<RunJob>('SELECT * FROM runs WHERE id = $1', [delivery.run_id]);
      if (!run.rows[0]) continue;

      await attemptWebhookDelivery(delivery.id, webhook.rows[0], run.rows[0], delivery.event_type);
    }
  } catch (err) {
    console.error('Webhook retry processor error:', err);
  }
}

/**
 * Notify about new run.
 */
export async function notifyNewRun(runId: string): Promise<void> {
  await redis.publish('run:new', runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
