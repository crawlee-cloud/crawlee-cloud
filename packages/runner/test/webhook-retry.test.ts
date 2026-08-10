/**
 * Tests for the webhook retry machinery (queue.ts): scheduleRetry's
 * backoff ladder and give-up path, maybeRetryRun's actor retry policy,
 * and the processWebhookRetries drain loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  scheduleRetry,
  maybeRetryRun,
  isInfraFailure,
  processWebhookRetries,
  type RunJob,
} from '../src/queue.js';

/**
 * Pool double. `connect()` hands back a client whose queries share the
 * same `query` mock, so a test reads ONE ordered call sequence whether a
 * statement ran on the pool or inside maybeRetryRun's transaction.
 * BEGIN/COMMIT/ROLLBACK auto-resolve into `txStatements` instead of
 * consuming queued results, so adding transaction control to the code
 * under test never shifts a test's result queue.
 */
function mockPool(...results: { rows: unknown[] }[]) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  const txStatements: string[] = [];
  const release = vi.fn();
  const client = {
    query: (...args: unknown[]) => {
      const sql = String(args[0]).trim().toUpperCase();
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        txStatements.push(sql);
        return Promise.resolve({ rows: [] });
      }
      return query(...args);
    },
    release,
  };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    txStatements,
    release,
  } as unknown as pg.Pool & {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    txStatements: string[];
    release: ReturnType<typeof vi.fn>;
  };
}

/** Find a recorded query by SQL fragment — index-independent, so an
 *  added statement (a lock, a guard) doesn't break every assertion.
 *  Returns undefined when absent; use it to assert a query did NOT run. */
function findCall(
  db: { query: ReturnType<typeof vi.fn> },
  fragment: string | RegExp
): [string, unknown[]] | undefined {
  const match = db.query.mock.calls.find((c) =>
    typeof fragment === 'string' ? String(c[0]).includes(fragment) : fragment.test(String(c[0]))
  );
  return match as [string, unknown[]] | undefined;
}

/** findCall for the queries a test expects to exist. Throws with the
 *  fragment named rather than letting a destructure of `undefined` fail
 *  as an opaque TypeError. (Test files aren't in tsconfig's `include`,
 *  so a `!` here would be unchecked anyway — and the lint autofixer
 *  strips it.) */
function mustFindCall(
  db: { query: ReturnType<typeof vi.fn> },
  fragment: string | RegExp
): [string, unknown[]] {
  const match = findCall(db, fragment);
  if (!match) throw new Error(`No query matching ${String(fragment)} was issued`);
  return match;
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

    const [sql, params] = mustFindCall(db, 'INSERT INTO runs');
    expect(sql).toContain("INTERVAL '1 second'");
    const newRunId = params[0] as string;
    expect(params[8]).toBe(1); // retry_count bumped
    expect(params[9]).toBe('run-1'); // origin_run_id defaults to the failed run
    expect(params[10]).toBe(60); // actor's retry delay
    expect(redis.publish).toHaveBeenCalledWith('run:new', newRunId);
    // The clone is created inside a committed transaction.
    expect(db.txStatements).toEqual(['BEGIN', 'COMMIT']);
  });

  it('preserves the original origin_run_id across chained retries', async () => {
    const db = mockPool({ rows: [{ max_retries: 3, retry_delay_secs: 0 }] }, { rows: [] });
    const redis = fakeRedis();

    await maybeRetryRun({ ...RUN, retry_count: 1, origin_run_id: 'run-0' }, 'run-1', db, redis);

    const [, params] = mustFindCall(db, 'INSERT INTO runs');
    expect(params[9]).toBe('run-0');
    expect(params[8]).toBe(2);
  });

  // KEEP-IN-SYNC with the API's rerun endpoint: both take the same
  // per-chain advisory lock and run the same active-clone check, so a
  // manual rerun racing an infra auto-retry can't produce two live
  // clones of one chain.
  it('takes the per-chain advisory lock before checking for an active clone', async () => {
    const db = mockPool({ rows: [{ max_retries: 3, retry_delay_secs: 60 }] });
    const redis = fakeRedis();

    await maybeRetryRun({ ...RUN, retry_count: 1, origin_run_id: 'run-0' }, 'run-1', db, redis);

    const [lockSql, lockParams] = mustFindCall(db, 'pg_advisory_xact_lock');
    expect(lockSql).toContain("'rerun:'"); // same key namespace as the API
    expect(lockParams).toEqual(['run-0']); // keyed on the chain ROOT
    // The check must cover the root row itself, not just its clones.
    const [checkSql, checkParams] = mustFindCall(db, /origin_run_id = \$1 OR id = \$1/);
    expect(checkSql).toContain("'READY', 'RUNNING', 'ABORTING'");
    expect(checkParams).toEqual(['run-0']);
    // Lock is acquired BEFORE the check, or the check races.
    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      sqls.findIndex((s) => /origin_run_id = \$1 OR id = \$1/.test(s))
    );
  });

  it('skips the retry when a rerun of the same chain is already active', async () => {
    // A manual rerun committed first (or an earlier retry is still
    // queued): inserting here would give the chain two live clones.
    const db = mockPool(
      { rows: [{ max_retries: 3, retry_delay_secs: 60 }] },
      { rows: [] }, // advisory lock
      { rows: [{ found: 1 }] } // active clone exists
    );
    const redis = fakeRedis();

    await maybeRetryRun(RUN, 'run-1', db, redis);

    expect(findCall(db, 'INSERT INTO runs')).toBeUndefined();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(db.txStatements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(db.release).toHaveBeenCalled();
  });

  it('rolls back and releases the client when the retry INSERT fails', async () => {
    const db = mockPool({ rows: [{ max_retries: 3, retry_delay_secs: 60 }] });
    db.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // active-clone check: none
      .mockRejectedValueOnce(new Error('INSERT blew up'));
    const redis = fakeRedis();

    // Contained, like every other failure in this function — a retry
    // that can't be scheduled must not take down the queue worker.
    await expect(maybeRetryRun(RUN, 'run-1', db, redis)).resolves.toBeUndefined();

    expect(db.txStatements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(db.release).toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  // Infra failures (image pull died: disk full, registry down) are not
  // the actor's fault — they retry on a small platform floor even when
  // the actor itself has retries disabled (prod 2026-08-04: max_retries
  // is 0 fleet-wide, so 104 pull failures were all terminal).
  it('retries an infra failure even when the actor has retries disabled', async () => {
    const db = mockPool({ rows: [{ max_retries: 0, retry_delay_secs: 0 }] }, { rows: [] });
    const redis = fakeRedis();

    await maybeRetryRun(RUN, 'run-1', db, redis, { infraFailure: true });

    const [, params] = mustFindCall(db, 'INSERT INTO runs');
    expect(params[8]).toBe(1); // retry_count bumped
    expect(params[10]).toBe(60); // delay floored to 60s, not the actor's 0
    expect(redis.publish).toHaveBeenCalled();
  });

  // The floor uses Math.max semantics: it may only RAISE a disabled
  // policy, never lower a generous one — an actor with 5 retries at 300s
  // keeps exactly that on an infra failure.
  it('never reduces a generous actor retry policy on infra failures', async () => {
    const db = mockPool({ rows: [{ max_retries: 5, retry_delay_secs: 300 }] }, { rows: [] });
    const redis = fakeRedis();

    await maybeRetryRun({ ...RUN, retry_count: 3 }, 'run-1', db, redis, { infraFailure: true });

    // retry_count 3 < 5 still allowed (floor is 2)
    const [, params] = mustFindCall(db, 'INSERT INTO runs');
    expect(params[8]).toBe(4);
    expect(params[10]).toBe(300); // actor's 300s delay kept, not floored down to 60
    expect(redis.publish).toHaveBeenCalled();
  });

  it('caps infra retries at the platform floor', async () => {
    const db = mockPool({ rows: [{ max_retries: 0, retry_delay_secs: 0 }] });
    const redis = fakeRedis();

    await maybeRetryRun({ ...RUN, retry_count: 2 }, 'run-1', db, redis, { infraFailure: true });

    expect(db.query).toHaveBeenCalledTimes(1); // actor lookup only, no INSERT
    expect(redis.publish).not.toHaveBeenCalled();
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

describe('isInfraFailure', () => {
  it('classifies image pull failures as infra failures', () => {
    expect(
      isInfraFailure('Image pull failed: failed to extract layer: no space left on device')
    ).toBe(true);
  });

  // Transport-level pull errors (registry outage, DNS, socket reset)
  // don't carry the prefix from the daemon — executeRun's pull catch
  // (docker.ts) stamps it by failure SITE. This pins the contract: the
  // classifier alone must NOT match raw transport messages, so the
  // site-wrap is load-bearing.
  it('relies on the executeRun site-wrap for transport-level pull errors', () => {
    expect(isInfraFailure('connect ECONNREFUSED 140.82.112.34:443')).toBe(false);
    expect(isInfraFailure('Image pull failed: connect ECONNREFUSED 140.82.112.34:443')).toBe(true);
  });

  // createContainer's 404 — reachable when disk-pressure eviction races
  // a just-pulled image in the pull→create window.
  it('classifies a missing image at container create as an infra failure', () => {
    expect(
      isInfraFailure('(HTTP code 404) no such image - No such image: crawlee-cloud/actor-x:latest')
    ).toBe(true);
  });

  it('does not classify actor errors as infra failures', () => {
    expect(isInfraFailure('Container exited with code 1')).toBe(false);
  });
});
