/**
 * Run/webhook claiming — regression tests for the cross-process race.
 *
 * Background: `SELECT ... FOR UPDATE SKIP LOCKED` in auto-commit releases
 * its row lock the moment the statement returns; a separate follow-up
 * UPDATE lets two runner processes claim the same row (reproduced live
 * against PG 16 — two runners spawned containers for the same run). The
 * fix is a single atomic statement: UPDATE ... WHERE id IN/= (SELECT ...
 * FOR UPDATE SKIP LOCKED) RETURNING. These tests lock that shape in.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  claimNextRun,
  claimWebhookRetries,
  createAbortHandler,
  processNextRun,
} from '../src/queue.js';

function mockPool(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('claimNextRun', () => {
  it('claims READY -> RUNNING in ONE atomic statement (no separate UPDATE)', async () => {
    const pool = mockPool([{ id: 'run-1', status: 'RUNNING' }]);

    const run = await claimNextRun(pool as never, null);

    expect(run).toEqual({ id: 'run-1', status: 'RUNNING' });
    // The race lives between statements — the claim must be exactly one.
    expect(pool.query).toHaveBeenCalledTimes(1);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE runs/i);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(sql).toMatch(/status = 'READY'/);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('stamps cost-attribution columns in the SAME claim statement', async () => {
    // Claim-time stamping per the run-cost-analysis design
    // (docs/superpowers/specs/2026-07-15-run-cost-analysis-design.md):
    // runner_id groups sibling runs per droplet for overlap math and
    // per-droplet forensics; price/provider degrade to NULL/'local-docker'
    // when the scaler didn't inject them. A separate UPDATE would reopen
    // the claim race this file exists to prevent.
    const pool = mockPool([{ id: 'run-1', status: 'RUNNING' }]);

    await claimNextRun(pool as never, null);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/runner_id = \$1/);
    expect(sql).toMatch(/runner_price_hourly = \$2/);
    expect(sql).toMatch(/runner_provider = \$3/);

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(typeof params[0]).toBe('string'); // RUNNER_ID env or os.hostname()
    expect(params[1]).toBeNull(); // RUNNER_PRICE_HOURLY unset in tests
    expect(params[2]).toBe('local-docker'); // RUNNER_PROVIDER default
  });

  it('gates the claim on memory headroom INSIDE the same statement', async () => {
    // Memory-aware admission (2026-07-16 host-wedge incident): the claim
    // must skip runs whose effective limit — LEAST(memory_mbytes, host
    // usable) — exceeds remaining headroom, so co-located limits stay
    // enforceable by the kernel. Doing it in the claim statement keeps
    // the single-statement atomicity; a separate check would reopen the
    // two-claimants race.
    const pool = mockPool([]);

    await claimNextRun(pool as never, 1096);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/LEAST\(COALESCE\(memory_mbytes, \$5\), \$6\) <= \$4/);

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params).toHaveLength(7);
    expect(params[3]).toBe(1096); // headroom
    expect(typeof params[4]).toBe('number'); // default memory for NULL rows
    expect(typeof params[5]).toBe('number'); // host-usable clamp
    expect(typeof params[6]).toBe('number'); // starvation drain bound (secs)
  });

  it('busy hosts stop claiming past a starved run that fits nowhere (anti-starvation drain)', async () => {
    // A run whose limit exceeds every busy host's headroom is claimable
    // only via the idle null-gate — and hosts ping-ponging small claims
    // may never go idle. Past the wait bound, busy hosts must claim
    // NOTHING (NOT EXISTS guard) so the fleet drains toward an idle
    // claimant; idle hosts ($4 NULL) are never blocked.
    const pool = mockPool([]);

    await claimNextRun(pool as never, 1096);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/LEAST\(COALESCE\(starved\.memory_mbytes, \$5\), \$6\) > \$4/);
    // The wait clock starts at eligibility (run_after), not insert time —
    // a delayed retry must not trigger the drain the moment it appears.
    expect(sql).toMatch(
      /GREATEST\(starved\.created_at, COALESCE\(starved\.run_after, starved\.created_at\)\)/
    );
  });

  it('claims without a memory gate when headroom is null (idle host)', async () => {
    // Null (not "usable MB") on an idle host: an oversized run
    // (memory_mbytes > host usable) must still be claimable SOMEWHERE —
    // it runs solo with a clamped limit instead of starving READY forever.
    const pool = mockPool([{ id: 'run-big', status: 'RUNNING' }]);

    const run = await claimNextRun(pool as never, null);

    expect(run).not.toBeNull();
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull();
  });

  it('returns null when no READY run is available', async () => {
    const pool = mockPool([]);
    expect(await claimNextRun(pool as never, null)).toBeNull();
  });
});

describe('processNextRun', () => {
  it('contains claim failures — one lost poll tick, never a process-killing rejection', async () => {
    // The module-level pool is uninitialized in unit tests, so the claim
    // inside processNextRun fails exactly like a DB outage (failover,
    // 53300 no-slots, or 42703 against a not-yet-migrated schema) would.
    // Before the catch was added this rejection propagated through
    // startProcessing's poll loop into main().catch → exit with NO drain,
    // orphaning every active container. The crash guards can't help: a
    // rejection consumed by main().catch is a HANDLED rejection.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(processNextRun()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Claim poll failed'),
      expect.anything()
    );
    error.mockRestore();
  });
});

describe('claimWebhookRetries', () => {
  it('claims pending deliveries atomically and pushes next_retry_at forward', async () => {
    const pool = mockPool([{ id: 'd-1', webhook_id: 'w-1', run_id: 'r-1', event_type: 'X' }]);

    const claimed = await claimWebhookRetries(pool as never);

    expect(claimed).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledTimes(1);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE webhook_deliveries/i);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Claiming = making the row invisible to sibling pollers: the same
    // statement must push next_retry_at into the future so a crash
    // mid-delivery self-heals instead of duplicating the POST.
    expect(sql).toMatch(/SET next_retry_at = NOW\(\) \+/i);
    expect(sql).toMatch(/status = 'PENDING'/);
    // The re-arm horizon must exceed the batch worst case: up to 10
    // sequential deliveries × 30s fetch timeout = 300s. A shorter horizon
    // (the original 120s) let rows come due again while their own batch
    // was still draining — the same duplicate-POST class this fixes.
    expect(sql).toMatch(/INTERVAL '600 seconds'/);
  });
});

describe('createAbortHandler', () => {
  it('stops the container when the aborted run is active on this runner', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const handler = createAbortHandler(() => new Set(['run-1']), stop, vi.fn());

    await handler('run-1');

    expect(stop).toHaveBeenCalledWith('run-1');
  });

  it('marks the run aborted BEFORE stopping, so a pull-in-progress sees it', async () => {
    // During pullImageIfNeeded the container doesn't exist yet — stopRun
    // finds nothing and no-ops. The mark is what executeRun checks after
    // the pull, before starting the container; it must be recorded even
    // when there is nothing to stop yet.
    const order: string[] = [];
    const stop = vi.fn().mockImplementation(() => {
      order.push('stop');
      return Promise.resolve();
    });
    const markAborted = vi.fn().mockImplementation(() => order.push('mark'));
    const handler = createAbortHandler(() => new Set(['run-1']), stop, markAborted);

    await handler('run-1');

    expect(markAborted).toHaveBeenCalledWith('run-1');
    expect(order).toEqual(['mark', 'stop']);
  });

  it('ignores aborts for runs owned by other runners', async () => {
    const stop = vi.fn();
    const markAborted = vi.fn();
    const handler = createAbortHandler(() => new Set(['run-1']), stop, markAborted);

    await handler('run-owned-elsewhere');

    expect(stop).not.toHaveBeenCalled();
    expect(markAborted).not.toHaveBeenCalled();
  });

  it('does not throw when stopping fails (container may have already exited)', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('404 no such container'));
    const handler = createAbortHandler(() => new Set(['run-1']), stop, vi.fn());

    await expect(handler('run-1')).resolves.toBeUndefined();
  });
});
