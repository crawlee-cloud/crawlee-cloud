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
 *
 * S3 cleanup runs AFTER the DB phases finish and the advisory lock has been
 * released — the deleted rows are already committed, so nothing depends on
 * the lock during the S3 phase. This keeps the connection pool healthy
 * under load and lets sibling instances start their next DB tick while
 * we're still draining S3.
 */

import cron from 'node-cron';
import type pg from 'pg';
import { withAdvisoryLock, LOCK_IDS } from './db/index.js';
import { config } from './config.js';
import { deleteDatasetS3Prefix, deleteKVStoreS3Prefix } from './storage/s3.js';
import { redis } from './storage/redis.js';

/** Concurrency cap for S3 prefix deletions. */
const S3_CLEANUP_CONCURRENCY = 10;

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
 * Returns the IDs of reaped runs.
 */
export async function reapRuns(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ resource_id: string }>(
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
  return result.rows.map((r) => r.resource_id);
}

/**
 * Phase 2: reap unnamed datasets whose last activity is older than
 * retentionDays. Returns the IDs of reaped datasets so the caller can
 * delete the corresponding S3 prefixes after releasing the DB connection.
 *
 * "Last activity" = `GREATEST(accessed_at, modified_at)`. The data-write
 * paths (`POST /datasets/:id/items`) bump `modified_at` but not
 * `accessed_at`, so a dataset under active push but no reads would
 * otherwise be reaped after RETENTION_DAYS — taking `modified_at` into
 * account closes that gap without forcing every writer to remember to
 * touch `accessed_at`.
 */
export async function reapDatasets(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ resource_id: string }>(
    `WITH deleted AS (
       DELETE FROM datasets
         WHERE id IN (
           SELECT id FROM datasets
             WHERE name IS NULL
               AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
             ORDER BY GREATEST(accessed_at, modified_at) ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         AND name IS NULL
         AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
       RETURNING id, name, user_id, created_at
     )
     INSERT INTO retention_tombstones
       (resource_kind, resource_id, resource_name, user_id, reason,
        original_created_at)
     SELECT 'dataset', id, name, user_id, 'expired-unnamed', created_at
       FROM deleted
     RETURNING resource_id`,
    [config.retentionDays, config.retentionBatchSize]
  );
  return result.rows.map((r) => r.resource_id);
}

/**
 * Phase 3: reap unnamed KV stores whose last activity is older than
 * retentionDays. Same shape as reapDatasets — uses
 * `GREATEST(accessed_at, modified_at)` so KV record PUT/DELETE (which
 * only bumps modified_at) doesn't make the store look idle.
 */
export async function reapKVStores(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ resource_id: string }>(
    `WITH deleted AS (
       DELETE FROM key_value_stores
         WHERE id IN (
           SELECT id FROM key_value_stores
             WHERE name IS NULL
               AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
             ORDER BY GREATEST(accessed_at, modified_at) ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         AND name IS NULL
         AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
       RETURNING id, name, user_id, created_at
     )
     INSERT INTO retention_tombstones
       (resource_kind, resource_id, resource_name, user_id, reason,
        original_created_at)
     SELECT 'key_value_store', id, name, user_id, 'expired-unnamed', created_at
       FROM deleted
     RETURNING resource_id`,
    [config.retentionDays, config.retentionBatchSize]
  );
  return result.rows.map((r) => r.resource_id);
}

/**
 * Phase 4: reap unnamed request_queues whose accessed_at is older than
 * retentionDays. No S3 cleanup — request data lives in the requests table,
 * and ON DELETE CASCADE on requests.queue_id handles per-row cleanup
 * automatically.
 *
 * Caveat: a queue with very many requests (≥100K) generates a large CASCADE
 * inside one PG statement. See the spec's "Phase 4 long CASCADE" note.
 */
export async function reapRequestQueues(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ resource_id: string }>(
    `WITH deleted AS (
       DELETE FROM request_queues
         WHERE id IN (
           SELECT id FROM request_queues
             WHERE name IS NULL
               AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
             ORDER BY GREATEST(accessed_at, modified_at) ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         AND name IS NULL
         AND GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'
       RETURNING id, name, user_id, created_at
     )
     INSERT INTO retention_tombstones
       (resource_kind, resource_id, resource_name, user_id, reason,
        original_created_at)
     SELECT 'request_queue', id, name, user_id, 'expired-unnamed', created_at
       FROM deleted
     RETURNING resource_id`,
    [config.retentionDays, config.retentionBatchSize]
  );
  return result.rows.map((r) => r.resource_id);
}

/**
 * Phase 5: prune tombstones older than retentionTombstoneDays. Bounded by
 * RETENTION_BATCH_SIZE — at production scale tombstones can grow to
 * millions; pruning all-at-once would lock the table.
 */
export async function pruneTombstones(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `DELETE FROM retention_tombstones
       WHERE id IN (
         SELECT id FROM retention_tombstones
           WHERE deleted_at < NOW() - $1::int * INTERVAL '1 day'
           ORDER BY deleted_at ASC
           LIMIT $2
       )
     RETURNING id`,
    [config.retentionTombstoneDays, config.retentionBatchSize]
  );
  return result.rows.map((r) => r.id);
}

/**
 * Delete S3 prefixes in parallel with a bounded concurrency. Per-prefix
 * failures are logged but don't abort the batch — the DB rows are already
 * gone, so a stale S3 prefix is just orphaned bytes (cleanable later by
 * lifecycle policy or a future bookkeeping job).
 */
export async function cleanupDatasetS3Prefixes(ids: string[]): Promise<void> {
  await runWithConcurrency(ids, S3_CLEANUP_CONCURRENCY, async (id) => {
    try {
      await deleteDatasetS3Prefix(id);
    } catch (err) {
      console.error(
        `[retention] failed to delete S3 prefix datasets/${id}/: ${(err as Error).message}`
      );
    }
  });
}

export async function cleanupKVStoreS3Prefixes(ids: string[]): Promise<void> {
  await runWithConcurrency(ids, S3_CLEANUP_CONCURRENCY, async (id) => {
    try {
      await deleteKVStoreS3Prefix(id);
    } catch (err) {
      console.error(
        `[retention] failed to delete S3 prefix key-value-stores/${id}/: ${(err as Error).message}`
      );
    }
  });
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(worker));
  }
}

/**
 * Run the DB phases of one tick under the advisory lock and return the
 * IDs that need post-commit S3 cleanup. The lock is held only across the
 * SQL statements; the caller releases it before doing S3 work.
 */
async function runDbPhases(client: pg.PoolClient): Promise<{
  runs: string[];
  datasets: string[];
  kvStores: string[];
  requestQueues: string[];
  tombstones: string[];
}> {
  const runs = await reapRuns(client);
  const datasets = await reapDatasets(client);
  const kvStores = await reapKVStores(client);
  const requestQueues = await reapRequestQueues(client);
  const tombstones = await pruneTombstones(client);
  return { runs, datasets, kvStores, requestQueues, tombstones };
}

/**
 * Run a single reaper tick. Acquires pg_try_advisory_lock via the shared
 * helper, runs the 5 DB phases under the lock, then performs S3 cleanup
 * after the lock and connection are released.
 */
export async function runReaperTick(): Promise<void> {
  const tickStart = Date.now();

  const r = await withAdvisoryLock(LOCK_IDS.retention, async (client) => {
    return runDbPhases(client);
  });

  if (!r.acquired) {
    console.log('[retention] another instance is reaping; skip');
    return;
  }

  // The connection is back in the pool — S3 cleanup no longer blocks DB work.
  const phaseResult = r.result;
  await cleanupDatasetS3Prefixes(phaseResult.datasets);
  await cleanupKVStoreS3Prefixes(phaseResult.kvStores);

  const elapsed = Date.now() - tickStart;
  console.log(
    `[retention] tick complete elapsed=${elapsed}ms ` +
      `runs=${phaseResult.runs.length} datasets=${phaseResult.datasets.length} ` +
      `kv=${phaseResult.kvStores.length} queues=${phaseResult.requestQueues.length} ` +
      `tombstones-pruned=${phaseResult.tombstones.length}`
  );
  try {
    await redis.hset('retention:last-tick', {
      at: new Date().toISOString(),
      elapsed_ms: String(elapsed),
    });
  } catch (err) {
    console.error(`[retention] failed to write last-tick to Redis: ${(err as Error).message}`);
  }
}

/**
 * Register the cron job. Called from index.ts at startup. No-op when
 * RETENTION_ENABLED=false.
 *
 * The cron callback wraps `runReaperTick()` in `.catch()`. Without it, an
 * early rejection (e.g. `pool.connect()` failing because the DB is down or
 * the pool is exhausted) escapes the floating promise and — under Node's
 * default --unhandled-rejections=throw — would kill the API process.
 */
export function initRetention(): void {
  if (!config.retentionEnabled) {
    console.log('[retention] disabled (RETENTION_ENABLED=false); not registering cron');
    return;
  }
  cronTask = cron.schedule(
    config.retentionCron,
    () => {
      void runReaperTick().catch((err: unknown) => {
        console.error(`[retention] reaper tick crashed: ${(err as Error).message}`);
      });
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
