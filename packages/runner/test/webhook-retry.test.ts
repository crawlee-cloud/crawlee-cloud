/**
 * Tests for the webhook retry machinery (queue.ts): scheduleRetry's
 * backoff ladder and give-up path, maybeRetryRun's actor retry policy,
 * and the processWebhookRetries drain loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { scheduleRetry, maybeRetryRun, processWebhookRetries, type RunJob } from '../src/queue.js';

function mockPool(...results: { rows: unknown[] }[]) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  return { query } as unknown as pg.Pool & { query: ReturnType<typeof vi.fn> };
}

const RETRY_DELAYS = [10, 30, 60, 300, 900];

const RUN: RunJob = {
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'user-1',
  status: 'FAILED',
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'rq-1',
  timeout_secs: 300,
  memory_mbytes: 2048,
  retry_count: 0,
  origin_run_id: null,
  run_after: null,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scheduleRetry', () => {
  it('walks the backoff ladder by attempt count', async () => {
    const db = mockPool({ rows: [{ attempt_count: 1, max_attempts: 5 }] });
    await scheduleRetry('dlv-1', 500, 'err', '{}', RETRY_DELAYS, db);

    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('next_retry_at');
    expect(params[0]).toBe(2); // attempt_count bumped
    expect(params[4]).toBe(30); // second rung
  });

  it('clamps to the last rung when attempts outrun the ladder', async () => {
    const db = mockPool({ rows: [{ attempt_count: 6, max_attempts: 10 }] });
    await scheduleRetry('dlv-1', 500, 'err', '{}', RETRY_DELAYS, db);

    const [, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(params[4]).toBe(900);
  });

  it('marks the delivery FAILED once max attempts are reached', async () => {
    const db = mockPool({ rows: [{ attempt_count: 4, max_attempts: 5 }] });
    await scheduleRetry('dlv-1', 502, 'bad gateway', '{"a":1}', RETRY_DELAYS, db);

    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("status = 'FAILED'");
    expect(sql).toContain('next_retry_at = NULL');
    expect(params).toEqual([5, '{"a":1}', 502, 'bad gateway', 'dlv-1']);
  });

  it('is a no-op when the delivery row no longer exists', async () => {
    const db = mockPool({ rows: [] });
    await scheduleRetry('dlv-gone', 500, 'err', null, RETRY_DELAYS, db);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('maybeRetryRun', () => {
  function fakeRedis() {
    return { publish: vi.fn().mockResolvedValue(1) } as unknown as Redis & {
      publish: ReturnType<typeof vi.fn>;
    };
  }

  it('inserts a delayed retry run and notifies the queue', async () => {
    const db = mockPool({ rows: [{ max_retries: 3, retry_delay_secs: 60 }] }, { rows: [] });
    const redis = fakeRedis();

    await maybeRetryRun(RUN, 'run-1', db, redis);

    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO runs');
    expect(sql).toContain("INTERVAL '1 second'");
    const newRunId = params[0] as string;
    expect(params[8]).toBe(1); // retry_count bumped
    expect(params[9]).toBe('run-1'); // origin_run_id defaults to the failed run
    expect(params[10]).toBe(60); // actor's retry delay
    expect(redis.publish).toHaveBeenCalledWith('run:new', newRunId);
  });

  it('preserves the original origin_run_id across chained retries', async () => {
    const db = mockPool({ rows: [{ max_retries: 3, retry_delay_secs: 0 }] }, { rows: [] });
    const redis = fakeRedis();

    await maybeRetryRun({ ...RUN, retry_count: 1, origin_run_id: 'run-0' }, 'run-1', db, redis);

    const [, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(params[9]).toBe('run-0');
    expect(params[8]).toBe(2);
  });

  it('does nothing when the actor has retries disabled', async () => {
    const db = mockPool({ rows: [{ max_retries: 0, retry_delay_secs: 60 }] });
    const redis = fakeRedis();
    await maybeRetryRun(RUN, 'run-1', db, redis);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does nothing once the retry budget is spent', async () => {
    const db = mockPool({ rows: [{ max_retries: 2, retry_delay_secs: 60 }] });
    const redis = fakeRedis();
    await maybeRetryRun({ ...RUN, retry_count: 2 }, 'run-1', db, redis);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does nothing when the actor row is missing', async () => {
    const db = mockPool({ rows: [] });
    const redis = fakeRedis();
    await maybeRetryRun(RUN, 'run-1', db, redis);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('contains database errors instead of propagating them', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as pg.Pool;
    const redis = fakeRedis();
    await expect(maybeRetryRun(RUN, 'run-1', db, redis)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('processWebhookRetries', () => {
  const CLAIMED = {
    id: 'dlv-1',
    webhook_id: 'wh-1',
    run_id: 'run-1',
    event_type: 'ACTOR.RUN.FAILED',
  };
  const WEBHOOK_ROW = {
    id: 'wh-1',
    request_url: 'https://hooks.example.com/x',
    payload_template: null,
    headers: null,
  };

  it('redelivers a claimed retry end-to-end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') })
    );
    const db = mockPool(
      { rows: [CLAIMED] }, // claimWebhookRetries
      { rows: [WEBHOOK_ROW] }, // webhook lookup
      { rows: [RUN] }, // run lookup
      { rows: [] } // DELIVERED update
    );

    await processWebhookRetries(db);

    const [deliveredSql] = db.query.mock.calls[3] as [string];
    expect(deliveredSql).toContain("status = 'DELIVERED'");
  });

  it('fails the delivery when its webhook has been deleted', async () => {
    const db = mockPool(
      { rows: [CLAIMED] },
      { rows: [] }, // webhook gone
      { rows: [] } // FAILED update
    );

    await processWebhookRetries(db);

    const [failSql, failParams] = db.query.mock.calls[2] as [string, unknown[]];
    expect(failSql).toContain("status = 'FAILED'");
    expect(failParams).toEqual(['dlv-1']);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('fails the delivery when its run row is gone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const db = mockPool(
      { rows: [CLAIMED] },
      { rows: [WEBHOOK_ROW] },
      { rows: [] }, // run gone
      { rows: [] } // FAILED update
    );

    await processWebhookRetries(db);

    expect(fetchMock).not.toHaveBeenCalled();
    const [failSql, failParams] = db.query.mock.calls[3] as [string, unknown[]];
    expect(failSql).toContain("status = 'FAILED'");
    expect(failSql).toContain('next_retry_at = NULL');
    expect(failParams).toEqual(['dlv-1']);
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  it('contains claim errors instead of crashing the interval loop', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('pg reset')) } as unknown as pg.Pool;
    await expect(processWebhookRetries(db)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Webhook retry processor error:', expect.any(Error));
  });
});
