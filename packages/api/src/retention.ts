/**
 * Retention reaper — periodic cleanup of unnamed datasets/KVs/queues +
 * finished runs past TTL. See docs/superpowers/specs/2026-05-03-retention-
 * lifecycle-design.md for design rationale.
 *
 * Each tick acquires a Postgres advisory lock on a pinned pool connection
 * (to coordinate across multi-instance API deployments without operator
 * config), then runs 5 phases bounded by RETENTION_BATCH_SIZE. Each phase
 * is one CTE-with-recheck SQL statement combining DELETE + tombstone INSERT
 * for atomicity.
 */

import cron from 'node-cron';
import { pool } from './db/index.js';
import { config } from './config.js';

/**
 * Fixed 32-bit constant identifying the retention reaper's advisory lock.
 * MUST NOT collide with any other advisory lock in this codebase. See the
 * registry comment in db/index.ts.
 */
export const RETENTION_LOCK_ID = 0xc0debeef;

let cronTask: cron.ScheduledTask | null = null;

/**
 * Run a single reaper tick. Pins one pool connection for the entire window,
 * acquires pg_try_advisory_lock, runs the 5 phases, releases the lock. On
 * unlock failure, destroys the connection so the lock can't leak back into
 * the pool.
 */
export async function runReaperTick(): Promise<void> {
  const client = await pool.connect();
  let mustDestroy = false;
  try {
    const lock = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [RETENTION_LOCK_ID]
    );
    if (!lock.rows[0]?.pg_try_advisory_lock) {
      console.log('[retention] another instance is reaping; skip');
      return;
    }
    try {
      const tickStart = Date.now();
      // Phases 1-5 plug in here; for now the skeleton just logs a no-op tick.
      console.log(
        `[retention] tick complete elapsed=${Date.now() - tickStart}ms ` +
          `runs=0 datasets=0 kv=0 queues=0 tombstones-pruned=0`
      );
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_ID]);
      } catch (err) {
        mustDestroy = true;
        console.error(
          `[retention] pg_advisory_unlock failed; destroying connection: ${(err as Error).message}`
        );
      }
    }
  } finally {
    if (mustDestroy) {
      client.release(new Error('advisory unlock failed; connection destroyed'));
    } else {
      client.release();
    }
  }
}

/**
 * Register the cron job. Called from index.ts at startup. No-op when
 * RETENTION_ENABLED=false.
 */
export function initRetention(): void {
  if (!config.retentionEnabled) {
    console.log('[retention] disabled (RETENTION_ENABLED=false); not registering cron');
    return;
  }
  cronTask = cron.schedule(
    config.retentionCron,
    () => {
      void runReaperTick();
    },
    { timezone: 'UTC' }
  );
  console.log(
    `[retention] registered: cron='${config.retentionCron}' days=${config.retentionDays} ` +
      `batch=${config.retentionBatchSize}`
  );
}

/**
 * Stop the cron job. Called from index.ts on shutdown. In-flight ticks are
 * not cancelled; PG transaction atomicity protects against half-state on
 * mid-tick connection close.
 */
export function unregisterRetention(): void {
  if (cronTask) {
    void cronTask.stop();
    cronTask = null;
    console.log('[retention] unregistered');
  }
}
