/**
 * Tests for processNextRun's disk admission gate (queue.ts).
 *
 * Background (prod 2026-08-04/05): both runners' disks hit 100% from
 * accumulated actor images; every claimed run then fast-failed at image
 * pull ("no space left on device") in ~90s. Because work is runner-pull,
 * the sick runners out-claimed healthy capacity and DRAINED the READY
 * queue by failing it — so the scaler's queue-depth demand signal stayed
 * flat and no replacement was ever provisioned (104 failed runs, 40
 * actors dark). A disk-gated runner idles instead, the queue backs up,
 * and the scaler's existing starvation escalation manufactures capacity.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import { config } from '../src/config.js';
import { processNextRun, getActiveRunCount, type RunJob } from '../src/queue.js';

function claimRow(id: string, memoryMbytes = 512): RunJob {
  return {
    id,
    actor_id: 'actor-1',
    user_id: 'user-1',
    status: 'RUNNING',
    default_dataset_id: 'ds',
    default_key_value_store_id: 'kv',
    default_request_queue_id: 'rq',
    timeout_secs: 60,
    memory_mbytes: memoryMbytes,
    retry_count: 0,
    origin_run_id: null,
    run_after: null,
  };
}

function mockPool(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

const plentyOfMemory = () => config.memoryReserveMb + 10_000;

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await drain();
  expect(getActiveRunCount()).toBe(0);
  vi.restoreAllMocks();
});

describe('processNextRun disk gate', () => {
  it('skips claiming entirely when disk usage is at or above the threshold', async () => {
    const db = mockPool([claimRow('run-1')]);
    const processor = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await processNextRun({
      db,
      getAvailableMemory: plentyOfMemory,
      getDiskUsageRatio: () => config.diskClaimMaxPct / 100,
      runProcessor: processor,
      cleanup,
    });

    expect(db.query).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    // Gating without immediately kicking cleanup would leave the runner
    // idle for up to the full 30-minute periodic sweep interval.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('claims normally when disk usage is below the threshold', async () => {
    const db = mockPool([claimRow('run-2')]);
    const processor = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await processNextRun({
      db,
      getAvailableMemory: plentyOfMemory,
      getDiskUsageRatio: () => (config.diskClaimMaxPct - 10) / 100,
      runProcessor: processor,
      cleanup,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    await drain();
  });

  it('logs the pause when the gate engages and the resume when it clears', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await processNextRun({
      db: mockPool([]),
      getAvailableMemory: plentyOfMemory,
      getDiskUsageRatio: () => 0.99,
      runProcessor: vi.fn(),
      cleanup,
    });
    // Second gated tick must not spam the log again — nor re-fire the
    // cleanup kick (transition-edge only, debounced by diskThrottled).
    await processNextRun({
      db: mockPool([]),
      getAvailableMemory: plentyOfMemory,
      getDiskUsageRatio: () => 0.99,
      runProcessor: vi.fn(),
      cleanup,
    });
    const diskWarns = warn.mock.calls.filter((c) => String(c[0]).includes('disk'));
    expect(diskWarns).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);

    await processNextRun({
      db: mockPool([]),
      getAvailableMemory: plentyOfMemory,
      getDiskUsageRatio: () => 0.1,
      runProcessor: vi.fn(),
      cleanup,
    });
    const resumeLogs = log.mock.calls.filter((c) => String(c[0]).includes('disk'));
    expect(resumeLogs).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1); // no kick once pressure cleared
  });
});
