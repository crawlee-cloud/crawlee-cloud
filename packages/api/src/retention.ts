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
import type pg from 'pg';
import { pool } from './db/index.js';
import { config } from './config.js';

/**
 * Fixed 32-bit unsigned hex constant identifying the retention reaper's
 * advisory lock. Sent to PG as bigint via pg_try_advisory_lock's bigint
 * overload, since 0xC0DEBEEF exceeds INT4_MAX.
 * MUST NOT collide with any other advisory lock in this codebase. See the
 * registry comment in db/index.ts.
 */
export const RETENTION_LOCK_ID = 0xc0debeef;

let cronTask: cron.ScheduledTask | null = null;

/**
 * Phase 1: reap runs whose finished_at is older than retentionDays.
 *
 * Single CTE-with-recheck statement for atomicity. The inner SELECT acquires
 * row locks via FOR UPDATE SKIP LOCKED; the outer DELETE re-checks the
 * eligibility predicate (defense in depth — closes any window where a row's
 * state could have flipped, even though the lock should prevent that). The
 * outer INSERT writes one tombstone per deleted row, with metadata
 * carrying actor_id + status for audit.
 *
 * Returns the number of rows reaped.
 */
export async function reapRuns(client: pg.PoolClient): Promise<number> {
  const result = await client.query(
    `WITH deleted AS (
       DELETE FROM runs
         WHERE id IN (
           SELECT id FROM runs
             WHERE finished_at IS NOT NULL
               AND finished_at < NOW() - $1::int * INTERVAL '1 day'
             ORDER BY finished_at ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         AND finished_at IS NOT NULL
         AND finished_at < NOW() - $1::int * INTERVAL '1 day'
       RETURNING id, user_id, created_at, actor_id, status
     )
     INSERT INTO retention_tombstones
       (resource_kind, resource_id, resource_name, user_id, reason,
        original_created_at, metadata)
     SELECT 'run', id, NULL, user_id, 'expired-run', created_at,
            jsonb_build_object('actor_id', actor_id, 'status', status)
       FROM deleted
     RETURNING resource_id`,
    [config.retentionDays, config.retentionBatchSize]
  );
  return result.rowCount ?? 0;
}

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
      const stats = { runs: 0, datasets: 0, kvStores: 0, requestQueues: 0, tombstones: 0 };
      const tickStart = Date.now();
      stats.runs = await reapRuns(client);
      console.log(
        `[retention] tick complete elapsed=${Date.now() - tickStart}ms ` +
          `runs=${stats.runs} datasets=${stats.datasets} kv=${stats.kvStores} ` +
          `queues=${stats.requestQueues} tombstones-pruned=${stats.tombstones}`
      );
    } finally {
      try {
        const unlockResult = await client.query<{ pg_advisory_unlock: boolean }>(
          'SELECT pg_advisory_unlock($1)',
          [RETENTION_LOCK_ID]
        );
        if (!unlockResult.rows[0]?.pg_advisory_unlock) {
          console.error(
            '[retention] pg_advisory_unlock returned false — lock was not held by this session'
          );
        }
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
