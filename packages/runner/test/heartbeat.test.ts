/**
 * Unit tests for heartbeat.ts — metrics collection and the Redis
 * publish loop. Redis is injected as a parameter throughout, so plain
 * fake objects suffice (no vi.mock of ioredis). Module state
 * (previousCpuTimes, intervalHandle) is reset via vi.resetModules() +
 * dynamic import per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import type { Redis } from 'ioredis';

async function freshHeartbeat() {
  return import('../src/heartbeat.js');
}

function cpuSample(idle: number, busy: number) {
  return {
    model: 'fake',
    speed: 1000,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  } as ReturnType<typeof os.cpus>[number];
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getAvailableMemoryMb', () => {
  it('parses MemAvailable from /proc/meminfo into MB', async () => {
    const { getAvailableMemoryMb } = await freshHeartbeat();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'MemTotal:        8000000 kB\nMemFree:          512000 kB\nMemAvailable:    2048000 kB\n'
    );
    expect(getAvailableMemoryMb()).toBe(2000);
  });

  it('returns null when MemAvailable is missing', async () => {
    const { getAvailableMemoryMb } = await freshHeartbeat();
    vi.spyOn(fs, 'readFileSync').mockReturnValue('MemTotal: 8000000 kB\n');
    expect(getAvailableMemoryMb()).toBeNull();
  });

  it('returns null when /proc/meminfo is unreadable (non-Linux)', async () => {
    const { getAvailableMemoryMb } = await freshHeartbeat();
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getAvailableMemoryMb()).toBeNull();
  });
});

describe('collectMetrics', () => {
  it('reports rounded metrics and a healthy runner under normal load', async () => {
    const { collectMetrics } = await freshHeartbeat();
    vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 * 1024 * 1024);
    vi.spyOn(os, 'freemem').mockReturnValue(6 * 1024 * 1024 * 1024);
    vi.spyOn(os, 'hostname').mockReturnValue('test-host');
    vi.spyOn(os, 'uptime').mockReturnValue(123.6);
    vi.spyOn(os, 'cpus').mockReturnValue([cpuSample(900, 100)]);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({
      blocks: 100,
      bsize: 4096,
      bfree: 80,
    } as fs.StatsFs);

    const m = collectMetrics('runner-1', 2, ['a', 'b'], 5);
    expect(m.runnerId).toBe('runner-1');
    expect(m.hostname).toBe('test-host');
    // First CPU sample has no baseline — reported as 0.
    expect(m.cpuUsage).toBe(0);
    expect(m.memoryTotalMb).toBe(8192);
    expect(m.memoryUsedMb).toBe(2048);
    expect(m.memoryUsageRatio).toBe(0.25);
    expect(m.diskUsageRatio).toBe(0.2);
    expect(m.activeRuns).toBe(2);
    expect(m.runIds).toEqual(['a', 'b']);
    expect(m.maxConcurrentRuns).toBe(5);
    expect(m.healthy).toBe(true);
    expect(m.uptimeSecs).toBe(124);
    expect(() => new Date(m.timestamp)).not.toThrow();
  });

  it('computes CPU usage from the delta between samples', async () => {
    const { collectMetrics } = await freshHeartbeat();
    vi.spyOn(os, 'totalmem').mockReturnValue(1024 * 1024 * 1024);
    vi.spyOn(os, 'freemem').mockReturnValue(512 * 1024 * 1024);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ blocks: 1, bsize: 1, bfree: 1 } as fs.StatsFs);
    const cpusSpy = vi.spyOn(os, 'cpus').mockReturnValue([cpuSample(1000, 1000)]);

    collectMetrics('r', 0, [], 1); // establishes the baseline
    // Since baseline: idle +100, total +400 → 75% busy.
    cpusSpy.mockReturnValue([cpuSample(1100, 1300)]);
    const m = collectMetrics('r', 0, [], 1);
    expect(m.cpuUsage).toBe(0.75);
  });

  it('flags the runner unhealthy when memory exceeds 95%', async () => {
    const { collectMetrics } = await freshHeartbeat();
    vi.spyOn(os, 'totalmem').mockReturnValue(1000 * 1024 * 1024);
    vi.spyOn(os, 'freemem').mockReturnValue(10 * 1024 * 1024);
    vi.spyOn(os, 'cpus').mockReturnValue([cpuSample(100, 0)]);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ blocks: 1, bsize: 1, bfree: 1 } as fs.StatsFs);

    expect(collectMetrics('r', 0, [], 1).healthy).toBe(false);
  });

  it('treats an unreadable root filesystem as zero disk usage', async () => {
    const { collectMetrics } = await freshHeartbeat();
    vi.spyOn(os, 'totalmem').mockReturnValue(1024 * 1024 * 1024);
    vi.spyOn(os, 'freemem').mockReturnValue(512 * 1024 * 1024);
    vi.spyOn(os, 'cpus').mockReturnValue([cpuSample(100, 0)]);
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('not supported');
    });

    expect(collectMetrics('r', 0, [], 1).diskUsageRatio).toBe(0);
  });
});

describe('startHeartbeat / stopHeartbeat', () => {
  function fakeRedis() {
    return { set: vi.fn().mockResolvedValue('OK') };
  }

  function stubSystem() {
    vi.spyOn(os, 'totalmem').mockReturnValue(1024 * 1024 * 1024);
    vi.spyOn(os, 'freemem').mockReturnValue(512 * 1024 * 1024);
    vi.spyOn(os, 'hostname').mockReturnValue('hb-host');
    vi.spyOn(os, 'uptime').mockReturnValue(1);
    vi.spyOn(os, 'cpus').mockReturnValue([cpuSample(100, 0)]);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ blocks: 1, bsize: 1, bfree: 1 } as fs.StatsFs);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }

  it('publishes immediately and then on every interval tick', async () => {
    vi.useFakeTimers();
    const { startHeartbeat, stopHeartbeat } = await freshHeartbeat();
    stubSystem();
    const redis = fakeRedis();

    startHeartbeat(redis as unknown as Redis, 'runner-9', () => ({ count: 1, ids: ['x'] }), 3);
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, payload, exFlag, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(key).toBe('runner:heartbeat:runner-9');
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(90);
    const metrics = JSON.parse(payload) as { runnerId: string; activeRuns: number; ids?: never };
    expect(metrics.runnerId).toBe('runner-9');
    expect(metrics.activeRuns).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.set).toHaveBeenCalledTimes(2);

    stopHeartbeat();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('survives a Redis failure and keeps ticking', async () => {
    vi.useFakeTimers();
    const { startHeartbeat, stopHeartbeat } = await freshHeartbeat();
    stubSystem();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const redis = { set: vi.fn().mockRejectedValueOnce(new Error('conn reset')) };
    redis.set.mockResolvedValue('OK');

    startHeartbeat(redis as unknown as Redis, 'runner-9', () => ({ count: 0, ids: [] }), 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(errorSpy).toHaveBeenCalledWith('[Heartbeat] Failed to send:', 'conn reset');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.set).toHaveBeenCalledTimes(2);
    stopHeartbeat();
  });
});

describe('getAllHeartbeats', () => {
  it('returns [] without calling mget when no keys exist', async () => {
    const { getAllHeartbeats } = await freshHeartbeat();
    const redis = { keys: vi.fn().mockResolvedValue([]), mget: vi.fn() };
    expect(await getAllHeartbeats(redis as unknown as Redis)).toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('parses stored metrics and skips malformed or missing entries', async () => {
    const { getAllHeartbeats } = await freshHeartbeat();
    const good = { runnerId: 'a', activeRuns: 1 };
    const redis = {
      keys: vi
        .fn()
        .mockResolvedValue(['runner:heartbeat:a', 'runner:heartbeat:b', 'runner:heartbeat:c']),
      mget: vi.fn().mockResolvedValue([JSON.stringify(good), 'not-json{', null]),
    };
    const result = await getAllHeartbeats(redis as unknown as Redis);
    expect(result).toEqual([good]);
    expect(redis.keys).toHaveBeenCalledWith('runner:heartbeat:*');
  });
});
