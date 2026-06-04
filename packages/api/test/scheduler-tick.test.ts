import { describe, it, expect, beforeEach, vi } from 'vitest';

// Two distinct query mocks:
//   mockClientQuery: the PoolClient.query passed into the locked block.
//   mockQuery: the shared `query` export used by triggerScheduledRun.
const { mockClientQuery, mockQuery, fakeClient, mockWithLock } = vi.hoisted(() => {
  const cq = vi.fn();
  return {
    mockClientQuery: cq,
    mockQuery: vi.fn(),
    fakeClient: { query: cq, release: vi.fn() },
    mockWithLock: vi.fn(),
  };
});

vi.mock('../src/db/index.js', () => ({
  pool: { connect: vi.fn().mockResolvedValue(fakeClient), query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
  withAdvisoryLock: mockWithLock,
  LOCK_IDS: { scheduler: 0xc0de0003 },
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: { publish: vi.fn() },
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

import { runSchedulerTick } from '../src/scheduler.js';

const baseSchedule = {
  id: 's1',
  user_id: 'u1',
  actor_id: 'a1',
  cron_expression: '*/5 * * * *',
  timezone: 'UTC',
  input: {},
  last_run_at: null,
  next_run_at: null,
};

describe('runSchedulerTick', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockQuery.mockReset();
    mockWithLock.mockReset();
  });

  it('follower path: no DB queries beyond the lock attempt', async () => {
    mockWithLock.mockResolvedValue({ acquired: false });
    await runSchedulerTick();
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('empty DB: no schedules due, no triggers', async () => {
    mockWithLock.mockImplementation(async (_id, work) => ({
      acquired: true,
      result: await work(fakeClient),
    }));
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT due

    await runSchedulerTick();
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('warm-up: legacy NULL next_run_at backfills without firing', async () => {
    mockWithLock.mockImplementation(async (_id, work) => ({
      acquired: true,
      result: await work(fakeClient),
    }));
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ ...baseSchedule, next_run_at: null }] }) // SELECT due
      .mockResolvedValueOnce({ rows: [] }); // UPDATE next_run_at

    await runSchedulerTick();

    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE schedules SET next_run_at/);
    expect(updateCall[1]![0]).toBeInstanceOf(Date); // computed next_run_at
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('due schedule: triggers a run and advances next_run_at', async () => {
    mockWithLock.mockImplementation(async (_id, work) => ({
      acquired: true,
      result: await work(fakeClient),
    }));
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ...baseSchedule, next_run_at: new Date(Date.now() - 1000) }],
      }) // SELECT due
      .mockResolvedValueOnce({ rows: [] }); // UPDATE schedules SET last_run_at, next_run_at
    // triggerScheduledRun looks up the actor's default_run_options first;
    // return a row so the function doesn't bail on the missing-actor path.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ default_run_options: null }] }) // SELECT actor defaults
      .mockResolvedValue({ rows: [] }); // datasets / kv / queues / runs INSERTs

    await runSchedulerTick();

    // 1 actor lookup + 4 storage/run INSERTs
    expect(mockQuery).toHaveBeenCalledTimes(5);
    const insertSqls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(insertSqls.some((s) => /INSERT INTO datasets/.test(s))).toBe(true);
    expect(insertSqls.some((s) => /INSERT INTO key_value_stores/.test(s))).toBe(true);
    expect(insertSqls.some((s) => /INSERT INTO request_queues/.test(s))).toBe(true);
    expect(insertSqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);

    // The run INSERT carries timeout_secs and memory_mbytes (3600 / 1024
    // defaults when the actor has no default_run_options set).
    const runInsertCall = mockQuery.mock.calls.find((c) =>
      /INSERT INTO runs/.test(c[0] as string)
    ) as [string, unknown[]];
    expect(runInsertCall[0]).toContain('timeout_secs');
    expect(runInsertCall[1]).toContain(3600);
    expect(runInsertCall[1]).toContain(1024);

    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE schedules\s+SET last_run_at = NOW\(\),\s+next_run_at/);
    expect(updateCall[1]![0]).toBeInstanceOf(Date);
    expect((updateCall[1]![0] as Date).getTime()).toBeGreaterThan(Date.now());
  });
});
