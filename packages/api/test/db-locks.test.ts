import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as DbIndex from '../src/db/index.js';

// vi.mock is hoisted above top-level vars, so the mocks must be wrapped
// in vi.hoisted() to be accessible inside the factory closure.
const { mockConnect, mockQuery, mockRelease, fakeClient } = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  const c = { query: q, release: r };
  return {
    mockQuery: q,
    mockRelease: r,
    fakeClient: c,
    mockConnect: vi.fn().mockResolvedValue(c),
  };
});

vi.mock('../src/db/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof DbIndex>();
  // Mutate _dbState.pool so that withAdvisoryLock (which reads _dbState.pool
  // at call-time) picks up the fake pool without needing a real PG connection.
  original._dbState.pool = { connect: mockConnect } as never;
  return original;
});

import { withAdvisoryLock, LOCK_IDS } from '../src/db/index.js';

describe('withAdvisoryLock', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockRelease.mockReset();
    mockConnect.mockClear();
    mockConnect.mockResolvedValue(fakeClient);
  });

  it('acquires lock, runs work, unlocks', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] }) // acquire
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }); // unlock
    const work = vi.fn().mockResolvedValue('payload');

    const r = await withAdvisoryLock(LOCK_IDS.retention, work);

    expect(r).toEqual({ acquired: true, result: 'payload' });
    expect(work).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenNthCalledWith(1, 'SELECT pg_try_advisory_lock($1::bigint)', [
      LOCK_IDS.retention,
    ]);
    expect(mockQuery).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1::bigint)', [
      LOCK_IDS.retention,
    ]);
    expect(mockRelease).toHaveBeenCalledWith(); // released cleanly, no error arg
  });

  it('returns { acquired: false } when lock already held; work NEVER called', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] });
    const work = vi.fn();

    const r = await withAdvisoryLock(LOCK_IDS.scaler, work);

    expect(r).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith(); // released cleanly
  });

  it('unlocks even when work throws; original error propagates', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const work = vi.fn().mockRejectedValue(new Error('work blew up'));

    await expect(withAdvisoryLock(LOCK_IDS.setup, work)).rejects.toThrow('work blew up');
    expect(mockQuery).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1::bigint)', [
      LOCK_IDS.setup,
    ]);
    expect(mockRelease).toHaveBeenCalledWith();
  });

  it('logs error when pg_advisory_unlock returns false; connection released normally', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: false }] }); // not held
    const work = vi.fn().mockResolvedValue('ok');

    const r = await withAdvisoryLock(LOCK_IDS.scheduler, work);

    expect(r).toEqual({ acquired: true, result: 'ok' });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock returned false')
    );
    expect(mockRelease).toHaveBeenCalledWith(); // released, not destroyed
    errSpy.mockRestore();
  });

  it('destroys connection when pg_advisory_unlock itself throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockRejectedValueOnce(new Error('connection broken'));
    const work = vi.fn().mockResolvedValue('ok');

    const r = await withAdvisoryLock(LOCK_IDS.retention, work);

    expect(r).toEqual({ acquired: true, result: 'ok' });
    // release called with an Error argument → pg destroys the connection
    expect(mockRelease).toHaveBeenCalledWith(expect.any(Error));
    errSpy.mockRestore();
  });

  it('two concurrent calls with DIFFERENT lock IDs both run their work', async () => {
    // Each connect() returns its own fake client so the two attempts
    // don't share mockQuery state.
    const clientA = { query: vi.fn(), release: vi.fn() };
    const clientB = { query: vi.fn(), release: vi.fn() };
    mockConnect.mockResolvedValueOnce(clientA).mockResolvedValueOnce(clientB);
    clientA.query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    clientB.query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    const [a, b] = await Promise.all([
      withAdvisoryLock(LOCK_IDS.retention, async () => 'A'),
      withAdvisoryLock(LOCK_IDS.scaler, async () => 'B'),
    ]);

    expect(a).toEqual({ acquired: true, result: 'A' });
    expect(b).toEqual({ acquired: true, result: 'B' });
  });
});
