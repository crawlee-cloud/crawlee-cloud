/**
 * The API's pg pool must survive Postgres killing one of its idle
 * connections (pg_terminate_backend, failover, restart). Without a pool
 * 'error' listener, pg-pool re-emits the idle client's error on the pool,
 * Node throws it as an unhandled 'error' event, and the process dies with
 * "terminating connection due to administrator command".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TEST_CONFIG } from './setup.js';

let pool: pg.Pool;
let getClient: () => Promise<pg.PoolClient>;

async function terminate(pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: TEST_CONFIG.databaseUrl });
  await admin.connect();
  try {
    const t = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]);
    expect(t.rows[0]!.ok).toBe(true);
  } finally {
    await admin.end();
  }
}

/** Collect uncaught exceptions while `fn` runs plus a short settle window. */
async function collectUncaught(fn: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_CONFIG.databaseUrl;
  process.env.NODE_ENV = 'test';
  const db = await import('../../src/db/index.js');
  await db.initDatabase();
  pool = db._dbState.pool;
  getClient = db.getClient;
});

afterAll(async () => {
  await pool?.end();
});

describe('API pg pool — server-side connection termination', () => {
  it('keeps the process alive and serves the next query after an idle backend is terminated', async () => {
    // Make sure there is an idle client in the pool and learn its backend pid.
    const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]!.pid;
    expect(pool.idleCount).toBeGreaterThanOrEqual(1);

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    // Spy on the pool's error emissions WITHOUT adding a listener of our own:
    // a test listener would itself prevent the crash and mask the bug.
    const emitted: Error[] = [];
    const origEmit = pool.emit.bind(pool);
    pool.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === 'error') emitted.push(args[0] as Error);
      return origEmit(event, ...args);
    }) as typeof pool.emit;

    // Kill it from a separate admin connection.
    await terminate(pid);

    try {
      const deadline = Date.now() + 5_000;
      while (emitted.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // Let any rethrow of an unhandled 'error' surface.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
      pool.emit = origEmit;
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.message).toMatch(/terminating connection/);
    expect(uncaught).toEqual([]);

    // The broken client was discarded; the next query opens a fresh one.
    const next = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(next.rows[0]!.pid).not.toBe(pid);
  });

  it('survives termination of a checked-out client between queries', async () => {
    const client = await getClient();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]!.pid;

    const uncaught = await collectUncaught(() => terminate(pid));
    expect(uncaught).toEqual([]);

    // The broken client refuses further queries; release() discards it.
    await expect(client.query('SELECT 1')).rejects.toThrow();
    client.release();

    const next = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(next.rows[0]!.pid).not.toBe(pid);
  });
});
