/**
 * clampMemoryToHost — regression tests for host-memory admission.
 *
 * Background (prod 2026-07-16): container memory LIMITS were passed to
 * Docker unchecked, so a 4096MB-limit container landed on droplets with
 * 3912MB physical RAM. A cgroup limit >= physical RAM is unenforceable —
 * the kernel OOM killer fires at HOST exhaustion and picks its own
 * victim: sometimes the actor container (clean FAILED), sometimes the
 * runner/dockerd (wedged droplet, dead heartbeat, zombie runs). The
 * clamp converts host-OOM roulette into a normal container OOM at a
 * limit the kernel can enforce.
 */

import { describe, it, expect } from 'vitest';
import { clampMemoryToHost, memoryUsageMbFromStats } from '../src/docker.js';

describe('clampMemoryToHost', () => {
  it('passes through limits that fit under host RAM minus the reserve', () => {
    expect(clampMemoryToHost(2048, 4096, 768)).toBe(2048);
    expect(clampMemoryToHost(512, 4096, 768)).toBe(512);
  });

  it('caps limits at host total minus reserve (the 4096-on-3912 case)', () => {
    // retailmenot requested 4096MB on droplets with 3912MB physical RAM.
    expect(clampMemoryToHost(4096, 3912, 768)).toBe(3912 - 768);
  });

  it('caps exactly-at-host limits too — the reserve is not optional', () => {
    expect(clampMemoryToHost(4096, 4096, 768)).toBe(4096 - 768);
  });

  it('keeps a 256MB floor when the reserve is misconfigured >= host RAM', () => {
    // A bad RUNNER_MEMORY_RESERVE_MB must not produce a 0/negative limit
    // (Docker rejects Memory < 6MB; tiny limits just OOM instantly).
    expect(clampMemoryToHost(1024, 512, 768)).toBe(256);
    expect(clampMemoryToHost(128, 512, 768)).toBe(128);
  });
});

describe('memoryUsageMbFromStats', () => {
  // Peak sampling feeds runs.peak_memory_mb (actor right-sizing). The
  // parser must mirror `docker stats`: usage MINUS reclaimable page
  // cache, or scrapers streaming responses through the file cache would
  // report footprints near their limit and defeat right-sizing entirely.
  const MB = 1024 * 1024;

  it('subtracts inactive_file (cgroup v2) from usage', () => {
    const stats = {
      memory_stats: { usage: 2048 * MB, stats: { inactive_file: 1024 * MB } },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(1024);
  });

  it('prefers total_inactive_file (hierarchical) when BOTH keys exist — cgroup v1', () => {
    // On v1 both keys are present; the leaf-only inactive_file misses
    // child cgroups' cache. Docker checks total_inactive_file first —
    // so must we, or v1 peaks overstate the working set.
    const stats = {
      memory_stats: {
        usage: 1536 * MB,
        stats: { inactive_file: 128 * MB, total_inactive_file: 512 * MB },
      },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(1024);
  });

  it('tolerates a missing stats sub-object (usage counts as-is)', () => {
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 512 * MB } })).toBe(512);
  });

  it('returns null for malformed frames instead of a bogus peak', () => {
    expect(memoryUsageMbFromStats({})).toBeNull();
    expect(memoryUsageMbFromStats(null)).toBeNull();
    expect(memoryUsageMbFromStats({ memory_stats: { usage: 'lots' } })).toBeNull();
    expect(memoryUsageMbFromStats({ memory_stats: { usage: NaN } })).toBeNull();
  });

  it('clamps to 0 when reclaimable cache exceeds usage (never negative)', () => {
    const stats = {
      memory_stats: { usage: 100 * MB, stats: { inactive_file: 200 * MB } },
    };
    expect(memoryUsageMbFromStats(stats)).toBe(0);
  });
});
