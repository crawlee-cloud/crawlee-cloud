/**
 * PostgreSQL database initialization and connection.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Internal mutable state. `withAdvisoryLock` (and other helpers that need a
 * live pool reference at call-time) read from `_dbState.pool` rather than
 * closing over the module-level `pool` variable.  This makes the reference
 * replaceable by tests without spawning a real Postgres connection:
 *
 * ```ts
 * vi.mock('../src/db/index.js', async (importOriginal) => {
 *   const orig = await importOriginal<...>();
 *   orig._dbState.pool = fakePool;
 *   return orig;
 * });
 * ```
 */
export const _dbState: { pool: pg.Pool } = {} as { pool: pg.Pool };

/**
 * Legacy named export. Kept for production-time consumers (health.ts,
 * setup.ts, auth/middleware.ts, routes/auth.ts, routes/users.ts) that
 * import { pool } directly. After initDatabase() runs, `pool` and
 * `_dbState.pool` point at the same Pool instance.
 *
 * NOTE FOR TESTS: replacing `_dbState.pool` via vi.mock does NOT reroute
 * legacy `pool`-importing modules. If a test needs to substitute the
 * pool for those callers as well, mock the consuming module's `pool`
 * import directly. Future work: migrate the legacy consumers off the
 * `pool` export so `_dbState.pool` is the only public reference.
 */
export let pool: pg.Pool;

export async function initDatabase(): Promise<void> {
  const useSSL = config.databaseUrl.includes('sslmode=') || config.nodeEnv === 'production';

  const p = new Pool({
    connectionString: config.databaseUrl,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: config.dbPoolMax,
  });

  pool = p;
  _dbState.pool = p;

  // Test connection
  const client = await _dbState.pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('Database connected successfully');
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return _dbState.pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return _dbState.pool.connect();
}

/**
 * Postgres advisory lock IDs registry. All advisory locks used in this
 * codebase MUST register their constant here so future additions can
 * pick non-colliding IDs.
 *
 * Convention: 32-bit unsigned hex, namespaced under 0xC0DE____ ("CODE
 * prefix") for crawlee-cloud subsystems. Values may exceed INT4_MAX;
 * PG accepts them via pg_try_advisory_lock's bigint overload.
 *
 *   0xC0DEBEEF  - retention reaper       (packages/api/src/retention.ts)
 *   0xC0DE0001  - admin/runner-key setup (packages/api/src/setup-gated.ts)
 *   0xC0DE0002  - scaler loop            (packages/api/src/scaler/index.ts)
 *   0xC0DE0003  - scheduler tick         (packages/api/src/scheduler.ts)
 *
 *   0xC0DE9000-0xC0DE9FFF — reserved for tests; never use in production code.
 */
export const LOCK_IDS = {
  retention: 0xc0debeef,
  setup: 0xc0de0001,
  scaler: 0xc0de0002,
  scheduler: 0xc0de0003,
} as const;

export type LockResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Acquire a PG session-level advisory lock for the duration of `work`.
 *
 * Behaviour:
 *   - Acquires a fresh pool connection (so each invocation is a distinct
 *     PG session — required for the lock to gate concurrent invocations
 *     from the same replica as well as cross-replica).
 *   - If pg_try_advisory_lock returns false → returns { acquired: false };
 *     does NOT invoke `work`.
 *   - If acquired → invokes work(client), then unlocks in `finally`.
 *   - If work throws → unlock still attempted, then the original error
 *     propagates.
 *   - If pg_advisory_unlock returns false (lock not held by this
 *     session) → logged as an error; connection released normally.
 *   - If pg_advisory_unlock itself throws → connection destroyed via
 *     `release(err)` so the never-released lock can't leak back into
 *     the pool. Mirrors the existing retention reaper's behavior.
 *
 * The pinned client is passed to `work` so callers that need
 * transactional consistency (e.g. CTE-based DELETE + tombstone INSERT in
 * retention) can keep their queries on the same session as the lock.
 * Read-only or independent queries can use the shared `query` helper
 * instead — no requirement either way.
 */
export async function withAdvisoryLock<T>(
  lockId: number,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<LockResult<T>> {
  const client = await _dbState.pool.connect();
  let acquired = false;
  let unlockError: Error | null = null;
  try {
    // Explicit ::bigint cast: lock IDs in our 0xC0DE____ namespace exceed
    // INT4_MAX (e.g. 0xC0DEBEEF = 3,235,823,343). Without the cast,
    // Postgres can pick the int4 overload of pg_try_advisory_lock and
    // throw "integer out of range" at runtime. Defensive — flagged by
    // bot review on PR #47.
    const r = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint)',
      [lockId]
    );
    acquired = r.rows[0]?.pg_try_advisory_lock === true;
    if (!acquired) {
      return { acquired: false };
    }
    try {
      const result = await work(client);
      return { acquired: true, result };
    } finally {
      try {
        const u = await client.query<{ pg_advisory_unlock: boolean }>(
          'SELECT pg_advisory_unlock($1::bigint)',
          [lockId]
        );
        if (u.rows[0]?.pg_advisory_unlock !== true) {
          console.error(
            `[db-locks] pg_advisory_unlock returned false for lock 0x${lockId.toString(16)} — lock was not held by this session`
          );
        }
      } catch (err) {
        unlockError = err as Error;
        console.error(
          `[db-locks] pg_advisory_unlock failed for lock 0x${lockId.toString(16)}; destroying connection: ${(err as Error).message}`
        );
      }
    }
  } finally {
    if (unlockError) {
      client.release(unlockError);
    } else {
      client.release();
    }
  }
}
