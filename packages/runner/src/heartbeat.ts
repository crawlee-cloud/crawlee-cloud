/**
 * Runner heartbeat — periodically publishes system metrics to Redis
 * so the scaler can make informed decisions about runner capacity.
 *
 * Metrics are stored at `runner:{runnerId}:heartbeat` with a TTL.
 * If a runner stops sending heartbeats, the key expires and the
 * scaler knows the runner is unhealthy.
 */

import os from 'os';
import fs from 'fs';
import type { Redis } from 'ioredis';

export interface RunnerMetrics {
  runnerId: string;
  hostname: string;
  /** CPU usage 0-1 (averaged across cores) */
  cpuUsage: number;
  /** Memory used in MB */
  memoryUsedMb: number;
  /** Total memory in MB */
  memoryTotalMb: number;
  /** Memory usage ratio 0-1 */
  memoryUsageRatio: number;
  /** Disk usage ratio 0-1 (root partition) */
  diskUsageRatio: number;
  /** Number of active runs */
  activeRuns: number;
  /** IDs of currently running runs */
  runIds: string[];
  /** Max concurrent runs configured */
  maxConcurrentRuns: number;
  /** Whether the runner considers itself healthy */
  healthy: boolean;
  /** ISO timestamp */
  timestamp: string;
  /** Uptime in seconds */
  uptimeSecs: number;
}

const HEARTBEAT_PREFIX = 'runner:heartbeat:';
const HEARTBEAT_TTL_SECS = 90; // expires if no heartbeat for 90s
const HEARTBEAT_INTERVAL_MS = 30_000; // send every 30s

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let previousCpuTimes: { idle: number; total: number } | null = null;

/**
 * Get CPU usage since last measurement (0-1).
 * First call returns 0 (no baseline yet).
 */
function getCpuUsage(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  if (!previousCpuTimes) {
    previousCpuTimes = { idle, total };
    return 0;
  }

  const idleDiff = idle - previousCpuTimes.idle;
  const totalDiff = total - previousCpuTimes.total;
  previousCpuTimes = { idle, total };

  return totalDiff === 0 ? 0 : 1 - idleDiff / totalDiff;
}

/**
 * Get root disk usage ratio (0-1).
 * Falls back to 0 if unavailable.
 */
function getDiskUsage(): number {
  try {
    // Read from /proc on Linux
    const stat = fs.statfsSync('/');
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    return total === 0 ? 0 : 1 - free / total;
  } catch {
    return 0;
  }
}

/**
 * Collect current system metrics.
 */
export function collectMetrics(
  runnerId: string,
  activeRuns: number,
  runIds: string[],
  maxConcurrentRuns: number
): RunnerMetrics {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpuUsage = getCpuUsage();
  const memoryUsageRatio = totalMem === 0 ? 0 : usedMem / totalMem;
  const diskUsageRatio = getDiskUsage();

  // Runner is unhealthy if memory > 95% or disk > 95%
  const healthy = memoryUsageRatio < 0.95 && diskUsageRatio < 0.95;

  return {
    runnerId,
    hostname: os.hostname(),
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memoryUsedMb: Math.round(usedMem / 1024 / 1024),
    memoryTotalMb: Math.round(totalMem / 1024 / 1024),
    memoryUsageRatio: Math.round(memoryUsageRatio * 100) / 100,
    diskUsageRatio: Math.round(diskUsageRatio * 100) / 100,
    activeRuns,
    runIds,
    maxConcurrentRuns,
    healthy,
    timestamp: new Date().toISOString(),
    uptimeSecs: Math.round(os.uptime()),
  };
}

/**
 * Publish metrics to Redis.
 */
async function publishHeartbeat(redis: Redis, metrics: RunnerMetrics): Promise<void> {
  const key = `${HEARTBEAT_PREFIX}${metrics.runnerId}`;
  await redis.set(key, JSON.stringify(metrics), 'EX', HEARTBEAT_TTL_SECS);
}

/**
 * Start the heartbeat loop.
 *
 * @param redis - Redis client
 * @param runnerId - Unique runner identifier (e.g. Droplet ID, hostname, or nanoid)
 * @param getActiveRuns - Callback that returns current active run count and IDs
 * @param maxConcurrentRuns - Max concurrent runs this runner supports
 */
export function startHeartbeat(
  redis: Redis,
  runnerId: string,
  getActiveRuns: () => { count: number; ids: string[] },
  maxConcurrentRuns: number
): void {
  console.log(
    `[Heartbeat] Starting for runner ${runnerId} (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`
  );

  // Initial heartbeat
  const send = async () => {
    try {
      const { count, ids } = getActiveRuns();
      const metrics = collectMetrics(runnerId, count, ids, maxConcurrentRuns);
      await publishHeartbeat(redis, metrics);
    } catch (err) {
      console.error('[Heartbeat] Failed to send:', (err as Error).message);
    }
  };

  void send();
  intervalHandle = setInterval(() => {
    void send();
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat loop.
 */
export function stopHeartbeat(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Heartbeat] Stopped');
  }
}

// ---- Functions for consumers (scaler) ----

/**
 * Read all runner heartbeats from Redis.
 * Used by the scaler to get real runner state.
 */
export async function getAllHeartbeats(redis: Redis): Promise<RunnerMetrics[]> {
  const keys = await redis.keys(`${HEARTBEAT_PREFIX}*`);
  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  const metrics: RunnerMetrics[] = [];

  for (const val of values) {
    if (val) {
      try {
        metrics.push(JSON.parse(val) as RunnerMetrics);
      } catch {
        // skip malformed entries
      }
    }
  }

  return metrics;
}
