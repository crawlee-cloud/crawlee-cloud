/**
 * Retention reaper unit tests. The five DB phases take a PoolClient
 * parameter (faked with {query}); the advisory lock, S3 helpers, Redis,
 * and cron registration are module-mocked. Complements the end-to-end
 * integration suite in test/integration/retention.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type pg from 'pg';

const mockConfig = vi.hoisted(() => ({
  retentionEnabled: false,
  retentionCron: '*/30 * * * *',
  retentionDays: 30,
  retentionTombstoneDays: 90,
  retentionBatchSize: 500,
}));
vi.mock('../src/config.js', () => ({ config: mockConfig }));

const mockWithAdvisoryLock = vi.fn();
vi.mock('../src/db/index.js', () => ({
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
  LOCK_IDS: { retention: 777 },
}));

const mockDeleteDatasetPrefix = vi.fn();
const mockDeleteKVPrefix = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  deleteDatasetS3Prefix: (...args: unknown[]) => mockDeleteDatasetPrefix(...args),
  deleteKVStoreS3Prefix: (...args: unknown[]) => mockDeleteKVPrefix(...args),
}));

const mockRedisHset = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: { hset: (...args: unknown[]) => mockRedisHset(...args) },
}));

const mockCronSchedule = vi.fn();
vi.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => mockCronSchedule(...args) },
}));

import {
  reapRuns,
  reapDatasets,
  reapKVStores,
  reapRequestQueues,
  pruneTombstones,
  cleanupDatasetS3Prefixes,
  cleanupKVStoreS3Prefixes,
  runReaperTick,
  initRetention,
} from '../src/retention.js';

function fakeClient(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.PoolClient & {
    query: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('DB reap phases', () => {
  it.each([
    ['reapRuns', reapRuns, 'DELETE FROM runs', 'expired-run'],
    ['reapDatasets', reapDatasets, 'DELETE FROM datasets', 'expired-unnamed'],
    ['reapKVStores', reapKVStores, 'DELETE FROM key_value_stores', 'expired-unnamed'],
    ['reapRequestQueues', reapRequestQueues, 'DELETE FROM request_queues', 'expired-unnamed'],
  ] as const)(
    '%s deletes with tombstones and returns reaped IDs',
    async (_name, fn, del, reason) => {
      const client = fakeClient([{ resource_id: 'a' }, { resource_id: 'b' }]);

      const ids = await fn(client);

      expect(ids).toEqual(['a', 'b']);
      const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(del);
      expect(sql).toContain('INSERT INTO retention_tombstones');
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(sql).toContain(reason);
      // Bounded by [retentionDays, batchSize].
      expect(params).toEqual([30, 500]);
    }
  );

  it('unnamed-resource phases only target rows with name IS NULL', async () => {
    const client = fakeClient();
    await reapDatasets(client);
    await reapKVStores(client);
    await reapRequestQueues(client);
    for (const call of client.query.mock.calls) {
      expect(call[0] as string).toContain('name IS NULL');
    }
  });

  it('pruneTombstones is bounded by tombstone TTL and batch size', async () => {
    const client = fakeClient([{ id: 't1' }]);

    const ids = await pruneTombstones(client);

    expect(ids).toEqual(['t1']);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM retention_tombstones');
    expect(params).toEqual([90, 500]);
  });
});

describe('S3 prefix cleanup', () => {
  it('deletes every prefix and survives per-item failures', async () => {
    mockDeleteDatasetPrefix
      .mockRejectedValueOnce(new Error('s3 down'))
      .mockResolvedValue(undefined);

    await cleanupDatasetS3Prefixes(['ds-1', 'ds-2', 'ds-3']);

    expect(mockDeleteDatasetPrefix).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('datasets/ds-1/'));
  });

  it('cleans KV store prefixes the same way', async () => {
    mockDeleteKVPrefix.mockResolvedValue(undefined);
    await cleanupKVStoreS3Prefixes(['kv-1', 'kv-2']);
    expect(mockDeleteKVPrefix).toHaveBeenCalledTimes(2);
  });
});

describe('runReaperTick', () => {
  it('skips the tick when another instance holds the advisory lock', async () => {
    mockWithAdvisoryLock.mockResolvedValueOnce({ acquired: false });

    await runReaperTick();

    expect(mockDeleteDatasetPrefix).not.toHaveBeenCalled();
    expect(mockRedisHset).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('[retention] another instance is reaping; skip');
  });

  it('runs S3 cleanup after the lock and records the tick in Redis', async () => {
    mockWithAdvisoryLock.mockResolvedValueOnce({
      acquired: true,
      result: {
        runs: ['r1'],
        datasets: ['d1'],
        kvStores: ['k1'],
        requestQueues: [],
        tombstones: [],
      },
    });
    mockDeleteDatasetPrefix.mockResolvedValue(undefined);
    mockDeleteKVPrefix.mockResolvedValue(undefined);
    mockRedisHset.mockResolvedValue(1);

    await runReaperTick();

    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(777, expect.any(Function));
    expect(mockDeleteDatasetPrefix).toHaveBeenCalledWith('d1');
    expect(mockDeleteKVPrefix).toHaveBeenCalledWith('k1');
    const [key, payload] = mockRedisHset.mock.calls[0] as [string, Record<string, string>];
    expect(key).toBe('retention:last-tick');
    expect(payload.at).toBeTruthy();
    expect(payload.elapsed_ms).toMatch(/^\d+$/);
  });

  it('tolerates a Redis bookkeeping failure', async () => {
    mockWithAdvisoryLock.mockResolvedValueOnce({
      acquired: true,
      result: { runs: [], datasets: [], kvStores: [], requestQueues: [], tombstones: [] },
    });
    mockRedisHset.mockRejectedValueOnce(new Error('redis away'));

    await expect(runReaperTick()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to write last-tick')
    );
  });
});

describe('initRetention', () => {
  afterEach(() => {
    // Reset here (not inline in test bodies) so it runs even when an
    // assertion fails mid-test.
    mockConfig.retentionEnabled = false;
  });

  it('does not register the cron when retention is disabled', () => {
    mockConfig.retentionEnabled = false;
    initRetention();
    expect(mockCronSchedule).not.toHaveBeenCalled();
  });

  it('registers the UTC cron when enabled', () => {
    mockConfig.retentionEnabled = true;
    mockCronSchedule.mockReturnValueOnce({ stop: vi.fn() });

    initRetention();

    expect(mockCronSchedule).toHaveBeenCalledWith('*/30 * * * *', expect.any(Function), {
      timezone: 'UTC',
    });
  });
});
