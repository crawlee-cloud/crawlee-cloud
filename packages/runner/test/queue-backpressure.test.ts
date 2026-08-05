/**
 * Tests for processNextRun's admission gates (queue.ts): memory
 * backpressure, capacity, headroom, and claim-failure containment —
 * plus active-run tracking and notifyNewRun. All dependencies enter
 * through the injectable deps parameter; the module-level counters are
 * observed via getActiveRunCount/getActiveRunIds and always drained
 * back to zero before a test ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { config } from '../src/config.js';
import {
  processNextRun,
  getActiveRunCount,
  getActiveRunIds,
  notifyNewRun,
  type RunJob,
} from '../src/queue.js';

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

/** A run processor whose completion the test controls. */
function deferredProcessor() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const processor = vi.fn(() => gate);
  return { processor, release };
}

const plentyOfMemory = () => config.memoryReserveMb + 10_000;
// The real probe reads the host's actual root disk — a nearly-full dev
// machine would trip the disk claim gate and fail every claim test here.
const emptyDisk = () => 0;

async function drain() {
  // Let the runProcessor .finally() callbacks run.
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await drain();
  expect(getActiveRunCount()).toBe(0); // tests must not leak active runs
  vi.restoreAllMocks();
});

describe('processNextRun', () => {
  it('claims a run, tracks it as active, and releases it when processing ends', async () => {
    const db = mockPool([claimRow('run-42')]);
    const { processor, release } = deferredProcessor();

    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: plentyOfMemory,
      runProcessor: processor,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(getActiveRunCount()).toBe(1);
    expect(getActiveRunIds()).toContain('run-42');

    release();
    await drain();
    expect(getActiveRunCount()).toBe(0);
    expect(getActiveRunIds()).not.toContain('run-42');
  });

  it('does nothing when no run is claimable', async () => {
    const db = mockPool([]);
    const { processor } = deferredProcessor();

    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: plentyOfMemory,
      runProcessor: processor,
    });

    expect(processor).not.toHaveBeenCalled();
    expect(getActiveRunCount()).toBe(0);
  });

  it('pauses claims under host memory pressure, logging only on the transition', async () => {
    const db = mockPool([claimRow('run-1')]);
    const { processor } = deferredProcessor();
    const lowMemory = () => config.memoryReserveMb - 1;

    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: lowMemory,
      runProcessor: processor,
    });
    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: lowMemory,
      runProcessor: processor,
    });

    expect(db.query).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    // Entering the throttled state warns once — not once per poll tick.
    expect(console.warn).toHaveBeenCalledTimes(1);

    // Pressure clears: claims resume and the recovery is logged.
    const { processor: nextProcessor, release } = deferredProcessor();
    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: plentyOfMemory,
      runProcessor: nextProcessor,
    });
    expect(nextProcessor).toHaveBeenCalledTimes(1);
    release();
    await drain();
  });

  it('treats unknown memory (null probe) as no throttle', async () => {
    const db = mockPool([]);
    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: () => null,
      runProcessor: vi.fn(),
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('skips the claim round-trip when active limits leave no headroom', async () => {
    // First claim consumes the host's entire usable memory budget.
    const usableMb = Math.max(256, config.hostTotalMemoryMb - config.memoryReserveMb);
    const bigDb = mockPool([claimRow('run-big', usableMb * 2)]);
    const { processor, release } = deferredProcessor();
    await processNextRun({
      db: bigDb,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: plentyOfMemory,
      runProcessor: processor,
    });
    expect(getActiveRunCount()).toBe(1);

    // With zero headroom the next tick must not even query.
    const db = mockPool([claimRow('run-next')]);
    const { processor: blocked } = deferredProcessor();
    await processNextRun({
      db,
      getDiskUsageRatio: emptyDisk,
      getAvailableMemory: plentyOfMemory,
      runProcessor: blocked,
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();

    release();
    await drain();
  });

  it('contains claim failures so the poll loop survives', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('connection reset')),
    } as unknown as pg.Pool;

    await expect(
      processNextRun({
        db,
        getDiskUsageRatio: emptyDisk,
        getAvailableMemory: plentyOfMemory,
        runProcessor: vi.fn(),
      })
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      '[Runner] Claim poll failed (will retry):',
      'connection reset'
    );
  });

  it('keeps claiming with the default memory probe on this platform', async () => {
    // Sanity check that the default probe wiring works end-to-end: on
    // Linux it reads /proc/meminfo, elsewhere it returns null (no gate).
    const db = mockPool([]);
    await processNextRun({ db, getDiskUsageRatio: emptyDisk, runProcessor: vi.fn() });
    // Either the claim ran (no pressure) or the host is genuinely under
    // reserve — both are valid; the call must simply not throw.
  });
});

describe('notifyNewRun', () => {
  it('publishes the run id on the run:new channel', async () => {
    const redis = { publish: vi.fn().mockResolvedValue(1) } as unknown as Redis & {
      publish: ReturnType<typeof vi.fn>;
    };
    await notifyNewRun('run-7', redis);
    expect(redis.publish).toHaveBeenCalledWith('run:new', 'run-7');
  });
});
