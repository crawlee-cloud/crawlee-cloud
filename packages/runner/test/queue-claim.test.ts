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
import { claimNextRun, claimWebhookRetries, createAbortHandler } from '../src/queue.js';

function mockPool(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('claimNextRun', () => {
  it('claims READY -> RUNNING in ONE atomic statement (no separate UPDATE)', async () => {
    const pool = mockPool([{ id: 'run-1', status: 'RUNNING' }]);

    const run = await claimNextRun(pool as never);

    expect(run).toEqual({ id: 'run-1', status: 'RUNNING' });
    // The race lives between statements — the claim must be exactly one.
    expect(pool.query).toHaveBeenCalledTimes(1);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE runs/i);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(sql).toMatch(/status = 'READY'/);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('returns null when no READY run is available', async () => {
    const pool = mockPool([]);
    expect(await claimNextRun(pool as never)).toBeNull();
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
  });
});

describe('createAbortHandler', () => {
  it('stops the container when the aborted run is active on this runner', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const handler = createAbortHandler(() => new Set(['run-1']), stop);

    await handler('run-1');

    expect(stop).toHaveBeenCalledWith('run-1');
  });

  it('ignores aborts for runs owned by other runners', async () => {
    const stop = vi.fn();
    const handler = createAbortHandler(() => new Set(['run-1']), stop);

    await handler('run-owned-elsewhere');

    expect(stop).not.toHaveBeenCalled();
  });

  it('does not throw when stopping fails (container may have already exited)', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('404 no such container'));
    const handler = createAbortHandler(() => new Set(['run-1']), stop);

    await expect(handler('run-1')).resolves.toBeUndefined();
  });
});
