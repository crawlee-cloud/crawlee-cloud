/**
 * Integration tests requiring a real Postgres. Lives under test/integration/
 * which is excluded from the default vitest run (see vitest.config.ts:7).
 * Run via: npx vitest run packages/api/test/integration/multi-replica.int.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_LOCK_A = 0xc0de9001;
const TEST_LOCK_B = 0xc0de9002;

// Set env BEFORE importing db/index — config reads env at module load
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/crawlee_cloud';

const db = await import('../../src/db/index.js');
const { withAdvisoryLock, initDatabase, _dbState } = db;

describe('Advisory locks (real PG)', () => {
  beforeAll(async () => {
    // initDatabase wires up the real pool against DATABASE_URL.
    await initDatabase();
    // Ensure both test locks are released from any prior aborted run.
    const c = await _dbState.pool.connect();
    try {
      await c.query('SELECT pg_advisory_unlock_all()');
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await _dbState.pool.end();
  });

  it('two PoolClients on the same lockId — exactly one acquires', async () => {
    const c1 = await _dbState.pool.connect();
    const c2 = await _dbState.pool.connect();
    try {
      const r1 = await c1.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        TEST_LOCK_A,
      ]);
      const r2 = await c2.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        TEST_LOCK_A,
      ]);
      // Order-independent: assert the SET of outcomes
      const outcomes = [r1.rows[0]?.ok, r2.rows[0]?.ok].sort();
      expect(outcomes).toEqual([false, true]);
      // The winner unlocks
      await c1.query('SELECT pg_advisory_unlock($1)', [TEST_LOCK_A]);
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('withAdvisoryLock — second concurrent call observes { acquired: false }', async () => {
    let firstHolding = false;
    const a = withAdvisoryLock(TEST_LOCK_B, async () => {
      firstHolding = true;
      await new Promise((r) => setTimeout(r, 200));
      firstHolding = false;
      return 'A';
    });
    // Yield so 'a' starts and acquires before 'b' attempts
    await new Promise((r) => setTimeout(r, 50));
    const b = await withAdvisoryLock(TEST_LOCK_B, async () => 'B');
    expect(firstHolding).toBe(true);
    expect(b).toEqual({ acquired: false });
    const aResult = await a;
    expect(aResult).toEqual({ acquired: true, result: 'A' });
  });

  it('lock is released after work completes (subsequent call acquires)', async () => {
    const first = await withAdvisoryLock(TEST_LOCK_A, async () => 'first');
    expect(first).toEqual({ acquired: true, result: 'first' });
    const second = await withAdvisoryLock(TEST_LOCK_A, async () => 'second');
    expect(second).toEqual({ acquired: true, result: 'second' });
  });
});
