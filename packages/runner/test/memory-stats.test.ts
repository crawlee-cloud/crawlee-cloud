/**
 * Tests for memoryUsageMbFromStats (docker.ts) — converting Docker
 * container stats into a cache-excluding MB figure, handling both
 * cgroup v1 and v2 stat shapes.
 */
import { describe, it, expect } from 'vitest';
import { memoryUsageMbFromStats } from '../src/docker.js';

const MB = 1024 * 1024;

describe('memoryUsageMbFromStats', () => {
  it('subtracts total_inactive_file on cgroup v1 (both keys present)', () => {
    const stats = {
      memory_stats: {
        usage: 500 * MB,
        // v1 exposes both; total_inactive_file (including child cgroups)
        // must win over the leaf-only inactive_file.
        stats: { total_inactive_file: 200 * MB, inactive_file: 50 * MB },
      },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(300);
  });

  it('falls back to inactive_file on cgroup v2', () => {
    const stats = {
      memory_stats: { usage: 500 * MB, stats: { inactive_file: 100 * MB } },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(400);
  });

  it('treats missing stats breakdown as zero reclaimable cache', () => {
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 256 * MB } })).toBe(256);
  });

  it('ignores a non-numeric inactive_file value', () => {
    const stats = {
      memory_stats: { usage: 256 * MB, stats: { inactive_file: 'garbage' } },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(256);
  });

  it('clamps to zero when reclaimable cache exceeds usage', () => {
    const stats = {
      memory_stats: { usage: 100 * MB, stats: { total_inactive_file: 150 * MB } },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(0);
  });

  it('returns null for missing or malformed usage', () => {
    expect(memoryUsageMbFromStats(undefined)).toBeNull();
    expect(memoryUsageMbFromStats({})).toBeNull();
    expect(memoryUsageMbFromStats({ memory_stats: {} })).toBeNull();
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 'lots' } })).toBeNull();
    expect(memoryUsageMbFromStats({ memory_stats: { usage: Infinity } })).toBeNull();
  });

  it('rounds to the nearest MB', () => {
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 1.4 * MB } })).toBe(1);
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 1.6 * MB } })).toBe(2);
  });
});
