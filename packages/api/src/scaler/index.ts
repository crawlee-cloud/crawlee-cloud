/**
 * Runner auto-scaler — monitors the run queue and scales runner
 * VMs up/down based on demand.
 *
 * Disabled by default (SCALER_ENABLED=false). When enabled, runs as
 * a background loop inside the API process. Has zero impact on
 * single-Droplet or docker-compose deployments.
 */

import { query } from '../db/index.js';
import { redis } from '../storage/redis.js';
import type { RunnerProvider, RunnerInfo, ScalerConfig } from './types.js';
import { NoopProvider } from './providers/noop.js';
import { DigitalOceanProvider } from './providers/digitalocean.js';

let provider: RunnerProvider;
let config: ScalerConfig;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isScaling = false;

/** Runner state tracked in Redis (fast reads) and synced from provider */
const RUNNERS_KEY = 'scaler:runners';
const LAST_ACTIVITY_KEY = 'scaler:last-activity';

// ---- Cloud-init template for new runners ----

function getCloudInitScript(): string {
  const dbUrl = process.env.DATABASE_URL || '';
  const redisUrl = process.env.REDIS_URL || '';
  const apiBaseUrl = process.env.SCALER_API_BASE_URL || '';
  const ghcrToken = process.env.GHCR_TOKEN || '';

  return `#!/bin/bash
set -e
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Clone and build runner
git clone https://github.com/crawlee-cloud/crawlee-cloud.git /opt/crawlee-cloud
cd /opt/crawlee-cloud
npm install
npm run build --workspace=@crawlee-cloud/runner

# Login to GHCR if configured (for pulling pre-built actor images)
${ghcrToken ? `echo "${ghcrToken}" | docker login ghcr.io -u github --password-stdin` : '# No GHCR token'}

# Configure runner
cat > /etc/crawlee-runner.env << 'ENVEOF'
DATABASE_URL=${dbUrl}
REDIS_URL=${redisUrl}
API_BASE_URL=${apiBaseUrl}
DOCKER_NETWORK=bridge
MAX_CONCURRENT_RUNS=${config.runsPerRunner}
DEFAULT_MEMORY_MB=2048
DEFAULT_TIMEOUT_SECS=3600
LOG_LEVEL=info
NODE_TLS_REJECT_UNAUTHORIZED=0
ENVEOF
chmod 600 /etc/crawlee-runner.env

# Create systemd service
cat > /etc/systemd/system/crawlee-runner.service << 'EOF'
[Unit]
Description=Crawlee Cloud Runner
After=docker.service
Requires=docker.service
[Service]
Type=simple
WorkingDirectory=/opt/crawlee-cloud
ExecStart=/usr/bin/node packages/runner/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0
EnvironmentFile=/etc/crawlee-runner.env
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable crawlee-runner
systemctl start crawlee-runner

# Signal ready
curl -s -X POST "${apiBaseUrl}/v2/internal/runner-ready" -H "Content-Type: application/json" -d '{}' || true
`;
}

// ---- Scaling logic ----

interface QueueStats {
  ready: number;
  running: number;
  total: number;
}

async function getQueueStats(): Promise<QueueStats> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM runs
     WHERE status IN ('READY', 'RUNNING')
     GROUP BY status`
  );

  const stats: QueueStats = { ready: 0, running: 0, total: 0 };
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    if (row.status === 'READY') stats.ready = count;
    if (row.status === 'RUNNING') stats.running = count;
  }
  stats.total = stats.ready + stats.running;
  return stats;
}

function calculateDesiredRunners(stats: QueueStats, currentRunners: number): number {
  const { ready, running } = stats;
  const totalDemand = ready + running;

  if (totalDemand === 0) {
    return config.minRunners;
  }

  // Don't scale up until queue pressure exceeds threshold
  if (ready <= config.scaleUpThreshold && currentRunners >= config.minRunners) {
    return currentRunners;
  }

  // Each runner handles N concurrent runs
  const needed = Math.ceil(totalDemand / config.runsPerRunner);

  // Clamp to min/max
  return Math.max(config.minRunners, Math.min(needed, config.maxRunners));
}

async function getActiveRunners(): Promise<RunnerInfo[]> {
  try {
    const runners = await provider.listRunners();

    // Enrich runners with real metrics from heartbeats
    const heartbeatKeys = await redis.keys('runner:heartbeat:*');
    const heartbeats = new Map<
      string,
      { activeRuns: number; healthy: boolean; cpuUsage: number; memoryUsageRatio: number }
    >();

    if (heartbeatKeys.length > 0) {
      const values = await redis.mget(...heartbeatKeys);
      for (const val of values) {
        if (!val) continue;
        try {
          const hb = JSON.parse(val) as {
            runnerId: string;
            activeRuns: number;
            healthy: boolean;
            cpuUsage: number;
            memoryUsageRatio: number;
          };
          heartbeats.set(hb.runnerId, hb);
        } catch {
          // skip malformed
        }
      }
    }

    // Match heartbeats to runners by ID or hostname
    for (const runner of runners) {
      const hb = heartbeats.get(runner.id) || heartbeats.get(runner.ip);
      if (hb) {
        runner.activeRuns = hb.activeRuns;
        runner.status = hb.activeRuns > 0 ? 'busy' : 'ready';
        // Mark unhealthy runners
        if (!hb.healthy || hb.memoryUsageRatio > 0.95 || hb.cpuUsage > 0.95) {
          runner.status = 'draining';
        }
      } else {
        // No heartbeat — runner may still be booting or is dead
        const ageMs = Date.now() - runner.createdAt.getTime();
        if (ageMs > 180_000) {
          // Older than 3 minutes with no heartbeat — likely dead
          runner.status = 'draining';
        }
      }
    }

    return runners;
  } catch (err) {
    console.error('[Scaler] Failed to list runners:', (err as Error).message);
    return [];
  }
}

async function scaleUp(count: number): Promise<void> {
  console.log(`[Scaler] Scaling UP: creating ${count} runner(s)`);

  for (let i = 0; i < count; i++) {
    try {
      const runner = await provider.createRunner({
        region: config.runnerRegion,
        size: config.runnerSize,
        sshKeyId: config.sshKeyId,
        userData: getCloudInitScript(),
        tags: ['crawlee-runner', 'auto-scaled'],
      });
      console.log(`[Scaler] Created runner ${runner.id} at ${runner.ip}`);
    } catch (err) {
      console.error(`[Scaler] Failed to create runner:`, (err as Error).message);
    }
  }
}

async function scaleDown(runners: RunnerInfo[], count: number): Promise<void> {
  // Pick idle runners to destroy (prefer oldest)
  const idle = runners
    .filter((r) => r.activeRuns === 0 && r.status === 'ready')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const toDestroy = idle.slice(0, count);

  if (toDestroy.length === 0) {
    console.log(`[Scaler] Want to scale down ${count} but no idle runners available`);
    return;
  }

  console.log(`[Scaler] Scaling DOWN: destroying ${toDestroy.length} runner(s)`);

  for (const runner of toDestroy) {
    try {
      await provider.destroyRunner(runner.id);
      console.log(`[Scaler] Destroyed runner ${runner.id}`);
    } catch (err) {
      console.error(`[Scaler] Failed to destroy ${runner.id}:`, (err as Error).message);
    }
  }
}

async function scalingLoop(): Promise<void> {
  if (isScaling) return; // prevent overlapping checks
  isScaling = true;

  try {
    const stats = await getQueueStats();
    const runners = await getActiveRunners();
    const currentCount = runners.length;
    const desired = calculateDesiredRunners(stats, currentCount);

    // Track activity for idle timeout
    if (stats.total > 0) {
      await redis.set(LAST_ACTIVITY_KEY, Date.now().toString());
    }

    if (desired > currentCount) {
      await scaleUp(desired - currentCount);
    } else if (desired < currentCount) {
      // Check idle timeout before scaling down
      const lastActivity = await redis.get(LAST_ACTIVITY_KEY);
      const idleMs = lastActivity ? Date.now() - parseInt(lastActivity, 10) : Infinity;

      if (idleMs > config.idleTimeoutSecs * 1000) {
        await scaleDown(runners, currentCount - desired);
      } else {
        console.log(
          `[Scaler] Queue empty but idle timeout not reached (${Math.round(idleMs / 1000)}s / ${config.idleTimeoutSecs}s)`
        );
      }
    }

    // Log state periodically
    if (stats.total > 0 || currentCount > config.minRunners) {
      console.log(
        `[Scaler] Queue: ${stats.ready} ready, ${stats.running} running | Runners: ${currentCount}/${config.maxRunners} (desired: ${desired})`
      );
    }

    // Store runner state in Redis for API visibility
    await redis.set(RUNNERS_KEY, JSON.stringify(runners), 'EX', 120);
  } catch (err) {
    console.error('[Scaler] Error in scaling loop:', (err as Error).message);
  } finally {
    isScaling = false;
  }
}

// ---- Public API ----

/** Load scaler config from environment variables */
export function loadScalerConfig(): ScalerConfig {
  return {
    enabled: process.env.SCALER_ENABLED === 'true',
    provider: (process.env.SCALER_PROVIDER as ScalerConfig['provider']) || 'noop',
    minRunners: parseInt(process.env.SCALER_MIN_RUNNERS || '1', 10),
    maxRunners: parseInt(process.env.SCALER_MAX_RUNNERS || '5', 10),
    scaleUpThreshold: parseInt(process.env.SCALER_SCALE_UP_THRESHOLD || '5', 10),
    idleTimeoutSecs: parseInt(process.env.SCALER_IDLE_TIMEOUT_SECS || '600', 10),
    pollIntervalSecs: parseInt(process.env.SCALER_POLL_INTERVAL_SECS || '30', 10),
    runsPerRunner: parseInt(process.env.SCALER_RUNS_PER_RUNNER || '5', 10),
    runnerSize: process.env.SCALER_RUNNER_SIZE || 's-2vcpu-4gb',
    runnerRegion: process.env.SCALER_RUNNER_REGION || 'nyc1',
    sshKeyId: process.env.SCALER_SSH_KEY_ID || '',
    providerConfig: {
      DO_TOKEN: process.env.DO_TOKEN || process.env.DIGITALOCEAN_TOKEN || '',
      GHCR_TOKEN: process.env.GHCR_TOKEN || '',
      GHCR_REPO: process.env.GHCR_REPO || '',
    },
  };
}

/** Initialize and start the auto-scaler. Safe to call when disabled — returns immediately. */
export async function initScaler(): Promise<void> {
  config = loadScalerConfig();

  if (!config.enabled) {
    console.log('[Scaler] Disabled (SCALER_ENABLED != true)');
    return;
  }

  // Initialize provider
  switch (config.provider) {
    case 'digitalocean':
      provider = new DigitalOceanProvider(config.providerConfig);
      break;
    case 'noop':
    default:
      provider = new NoopProvider();
      break;
  }

  console.log(
    `[Scaler] Initialized with ${provider.name} provider | ` +
      `min=${config.minRunners} max=${config.maxRunners} ` +
      `poll=${config.pollIntervalSecs}s idle=${config.idleTimeoutSecs}s`
  );

  // Run initial check
  await scalingLoop();

  // Start periodic loop
  intervalHandle = setInterval(() => {
    void scalingLoop();
  }, config.pollIntervalSecs * 1000);
}

/** Stop the auto-scaler. Does NOT destroy runners. */
export function stopScaler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Scaler] Stopped');
  }
}

/** Get current scaler state for API endpoints */
export async function getScalerStatus(): Promise<{
  enabled: boolean;
  provider: string;
  runners: RunnerInfo[];
  heartbeats: Record<string, unknown>[];
  queue: QueueStats;
  config: { min: number; max: number; runsPerRunner: number };
}> {
  const queue = await getQueueStats();

  const runnersJson = await redis.get(RUNNERS_KEY);
  const runners: RunnerInfo[] = runnersJson ? JSON.parse(runnersJson) : [];

  // Read live heartbeats
  const heartbeatKeys = await redis.keys('runner:heartbeat:*');
  const heartbeats: Record<string, unknown>[] = [];
  if (heartbeatKeys.length > 0) {
    const values = await redis.mget(...heartbeatKeys);
    for (const val of values) {
      if (val) {
        try {
          heartbeats.push(JSON.parse(val) as Record<string, unknown>);
        } catch {
          // skip
        }
      }
    }
  }

  return {
    enabled: config?.enabled ?? false,
    provider: provider?.name ?? 'none',
    runners,
    heartbeats,
    queue,
    config: {
      min: config?.minRunners ?? 0,
      max: config?.maxRunners ?? 0,
      runsPerRunner: config?.runsPerRunner ?? 0,
    },
  };
}
