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
import { LocalDockerProvider } from './providers/local-docker.js';

let provider: RunnerProvider;
let config: ScalerConfig;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isScaling = false;

/** Runner state tracked in Redis (fast reads) and synced from provider */
const RUNNERS_KEY = 'scaler:runners';
const LAST_ACTIVITY_KEY = 'scaler:last-activity';

/** Parse a positive integer env var, falling back on missing/NaN/non-finite values. */
function intEnv(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/**
 * Cursor-based SCAN replacement for `redis.keys(pattern)`. KEYS is O(N) over
 * the entire keyspace and blocks the Redis event loop — fine in tests, lethal
 * on a shared Redis at scale. SCAN walks in batches without blocking.
 */
async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    keys.push(...found);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

/**
 * Memory/timeout values the DigitalOcean cloud-init heredoc bakes into
 * /etc/crawlee-runner.env. These are runner defaults for the digitalocean
 * provider only — local-docker doesn't inject these and relies on the
 * runner's own config fallbacks (see PROVIDER_DEFAULTS below).
 */
export const CLOUD_INIT_DEFAULT_MEMORY_MB = 2048;
export const CLOUD_INIT_DEFAULT_TIMEOUT_SECS = 3600;

/**
 * Per-scaler-provider effective execution defaults — what runners actually
 * use at runtime when SCALER_ENABLED=true. Each entry must match the env
 * that provider's createRunner injects. When a provider only injects some
 * of MAX_CONCURRENT_RUNS / DEFAULT_MEMORY_MB / DEFAULT_TIMEOUT_SECS, runners
 * fall back to packages/runner/src/config.ts (currently 1024 / 3600), so
 * this table mirrors that fallback explicitly.
 *
 * Future work: have runners self-report effective config via heartbeat so
 * this lookup can go away — that would also catch operator overrides on
 * the runner host that the API can't see.
 */
const PROVIDER_DEFAULTS: Record<string, { defaultMemoryMb: number; defaultTimeoutSecs: number }> = {
  // Cloud-init writes these values explicitly into /etc/crawlee-runner.env.
  digitalocean: {
    defaultMemoryMb: CLOUD_INIT_DEFAULT_MEMORY_MB,
    defaultTimeoutSecs: CLOUD_INIT_DEFAULT_TIMEOUT_SECS,
  },
  // Only injects MAX_CONCURRENT_RUNS — runners fall back to config.ts.
  'local-docker': { defaultMemoryMb: 1024, defaultTimeoutSecs: 3600 },
  // No runners actually run, but the dashboard panel still renders.
  noop: { defaultMemoryMb: 1024, defaultTimeoutSecs: 3600 },
};

export function getProviderExecutionDefaults(provider: string): {
  defaultMemoryMb: number;
  defaultTimeoutSecs: number;
} {
  // Unknown provider → mirror the runner's own config-side fallbacks
  // rather than guessing. Surfaces a wrong-but-honest value over a
  // confidently-misleading one.
  return PROVIDER_DEFAULTS[provider] ?? { defaultMemoryMb: 1024, defaultTimeoutSecs: 3600 };
}

// ---- Cloud-init template for new runners ----

/**
 * Render the cloud-init script that bootstraps a freshly-created VM into
 * a runner. Exported so it can be unit-tested in isolation — the script
 * is shell that runs on a real Linux box, so any unescaped value or
 * missing env var would only surface as a silent boot failure.
 *
 * Pure: only reads from `process.env` and the provided `runsPerRunner`.
 */
export function getCloudInitScript(runsPerRunner: number): string {
  const dbUrl = process.env.DATABASE_URL || '';
  const redisUrl = process.env.REDIS_URL || '';
  const apiBaseUrl = process.env.SCALER_API_BASE_URL || '';
  const ghcrToken = process.env.GHCR_TOKEN || '';
  // Off by default: when true, runners disable TLS cert verification globally.
  // Only valid escape hatch is internal CAs / self-signed certs the runner
  // can't otherwise trust. MITM-vulnerable when set.
  const insecureTls = process.env.SCALER_INSECURE_TLS === 'true';
  const tlsEnvFileLine = insecureTls ? 'NODE_TLS_REJECT_UNAUTHORIZED=0' : '';
  const tlsSystemdLine = insecureTls ? 'Environment=NODE_TLS_REJECT_UNAUTHORIZED=0' : '';

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
MAX_CONCURRENT_RUNS=${runsPerRunner}
DEFAULT_MEMORY_MB=${CLOUD_INIT_DEFAULT_MEMORY_MB}
DEFAULT_TIMEOUT_SECS=${CLOUD_INIT_DEFAULT_TIMEOUT_SECS}
LOG_LEVEL=info
IMAGE_REGISTRY=${process.env.IMAGE_REGISTRY || ''}
IMAGE_REGISTRY_USER=${process.env.IMAGE_REGISTRY_USER || ''}
IMAGE_REGISTRY_TOKEN=${process.env.IMAGE_REGISTRY_TOKEN || ''}
PROXY_ENCRYPTION_KEY=${process.env.PROXY_ENCRYPTION_KEY || ''}
${tlsEnvFileLine}
ENVEOF

# Pin RUNNER_ID to the DO droplet id (queried from the metadata service at
# boot). The runner uses RUNNER_ID as its Redis heartbeat key; without this,
# it falls back to os.hostname() (the droplet *name*), and the scaler — which
# looks up heartbeats by droplet id — never matches it, so every runner is
# marked dead and reaped. The api also matches by name as a fallback, so
# this curl failing isn't fatal.
DO_ID=$(curl -fsSL --max-time 5 http://169.254.169.254/metadata/v1/id 2>/dev/null || echo "")
[ -n "$DO_ID" ] && echo "RUNNER_ID=$DO_ID" >> /etc/crawlee-runner.env

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
${tlsSystemdLine}
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

export interface QueueStats {
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

/**
 * Pure function: given queue stats, current runner count, and scaler config,
 * return how many runners we want.
 *
 * Exported so it can be unit-tested without standing up the full loop.
 */
export function calculateDesiredRunners(
  stats: QueueStats,
  currentRunners: number,
  cfg: ScalerConfig
): number {
  const { ready, running } = stats;
  const totalDemand = ready + running;

  if (totalDemand === 0) {
    return cfg.minRunners;
  }

  // Don't scale up until queue pressure exceeds threshold
  if (ready <= cfg.scaleUpThreshold && currentRunners >= cfg.minRunners) {
    return currentRunners;
  }

  // Each runner handles N concurrent runs
  const needed = Math.ceil(totalDemand / cfg.runsPerRunner);

  // Clamp to min/max
  return Math.max(cfg.minRunners, Math.min(needed, cfg.maxRunners));
}

async function getActiveRunners(): Promise<RunnerInfo[]> {
  // Don't swallow listRunners errors here — a transient API failure that
  // returns [] would let calculateDesiredRunners think we have zero capacity
  // and over-provision on the next tick. Let the caller (scalingLoop) abort
  // the tick instead so we act on real data only.
  const runners = await provider.listRunners();

  // Enrich runners with real metrics from heartbeats
  const heartbeatKeys = await scanKeys('runner:heartbeat:*');
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

  // Match heartbeats to runners by id, ip, or name. The name fallback
  // exists because the runner publishes its heartbeat keyed on
  // `os.hostname()` when RUNNER_ID isn't set in its environment, and
  // some provisioning paths can't inject RUNNER_ID at boot. Providers
  // typically set the OS hostname to the same string they return as
  // `name` (DO droplet name; local-docker container name), so this
  // catches the gap without requiring every cloud-init path to be
  // perfect.
  for (const runner of runners) {
    const hb =
      heartbeats.get(runner.id) ||
      heartbeats.get(runner.ip) ||
      (runner.name ? heartbeats.get(runner.name) : undefined);
    if (hb) {
      runner.activeRuns = hb.activeRuns;
      runner.status = hb.activeRuns > 0 ? 'busy' : 'ready';
      // Mark unhealthy runners
      if (!hb.healthy || hb.memoryUsageRatio > 0.95 || hb.cpuUsage > 0.95) {
        runner.status = 'draining';
      }
    } else {
      // No heartbeat — runner may still be booting or is dead.
      // Threshold is env-configurable because cold-cloud-init paths
      // (apt install nodejs + git clone + npm install + build) can
      // exceed the default on slow apt mirrors or cold image caches,
      // causing healthy-but-still-booting droplets to be reaped.
      const ageMs = Date.now() - runner.createdAt.getTime();
      const deadAfterMs = intEnv('SCALER_REAPER_DEAD_AFTER_SECS', 180) * 1000;
      if (ageMs > deadAfterMs) {
        // Distinct from 'draining' (alive but stressed) so the reaper
        // can destroy it without conflating with demand-based scale-down.
        runner.status = 'dead';
      }
    }
  }

  return runners;
}

async function scaleUp(count: number): Promise<void> {
  console.log(`[Scaler] Scaling UP: creating ${count} runner(s)`);

  for (let i = 0; i < count; i++) {
    try {
      const runner = await provider.createRunner({
        region: config.runnerRegion,
        size: config.runnerSize,
        sshKeyId: config.sshKeyId,
        userData: getCloudInitScript(config.runsPerRunner),
        tags: ['crawlee-runner', 'auto-scaled'],
        runsPerRunner: config.runsPerRunner,
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

/**
 * Destroy runners marked 'dead' (no heartbeat for >3min) and return the
 * surviving list. This runs every tick, independent of demand — dead
 * runners are garbage, not capacity, so they should be reaped regardless
 * of whether the queue is full or empty.
 */
async function reapDeadRunners(runners: RunnerInfo[]): Promise<RunnerInfo[]> {
  const dead = runners.filter((r) => r.status === 'dead');
  if (dead.length === 0) return runners;

  console.log(`[Scaler] Reaping ${dead.length} dead runner(s)`);
  const reaped = new Set<string>();
  for (const runner of dead) {
    try {
      await provider.destroyRunner(runner.id);
      console.log(`[Scaler] Reaped dead runner ${runner.id}`);
      reaped.add(runner.id);
    } catch (err) {
      // Failed destroys MUST stay in the runner list: if we removed them
      // here, currentCount would understate real capacity and the scaler
      // would over-provision on the next tick. The provider's listRunners
      // will surface them again next time, where reap is retried.
      console.error(`[Scaler] Failed to reap ${runner.id}:`, (err as Error).message);
    }
  }
  return runners.filter((r) => !reaped.has(r.id));
}

async function scalingLoop(): Promise<void> {
  if (isScaling) return; // prevent overlapping checks
  isScaling = true;

  try {
    const stats = await getQueueStats();
    let runners = await getActiveRunners();
    runners = await reapDeadRunners(runners); // remove zombies before counting capacity
    const currentCount = runners.length;
    const desired = calculateDesiredRunners(stats, currentCount, config);

    // Track activity for idle timeout. TTL is 4x idleTimeoutSecs so the key
    // outlives a normal idle window but doesn't accumulate forever in Redis
    // if the scaler is later disabled.
    if (stats.total > 0) {
      await redis.set(
        LAST_ACTIVITY_KEY,
        Date.now().toString(),
        'EX',
        Math.max(60, config.idleTimeoutSecs * 4)
      );
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

    // Store runner state in Redis for API visibility. TTL must outlive the
    // poll interval — otherwise getScalerStatus reports an empty list during
    // the gap between expiry and the next tick.
    const runnersTtl = Math.max(120, config.pollIntervalSecs * 4);
    await redis.set(RUNNERS_KEY, JSON.stringify(runners), 'EX', runnersTtl);
  } catch (err) {
    console.error('[Scaler] Error in scaling loop:', (err as Error).message);
  } finally {
    isScaling = false;
  }
}

// ---- Public API ----

/** Load scaler config from environment variables. Invalid integers (NaN,
 * non-finite) fall back to the documented default rather than silently
 * disabling comparisons downstream. */
export function loadScalerConfig(): ScalerConfig {
  const minRunners = Math.max(0, intEnv('SCALER_MIN_RUNNERS', 1));
  const maxRunners = Math.max(minRunners, intEnv('SCALER_MAX_RUNNERS', 5));
  return {
    enabled: process.env.SCALER_ENABLED === 'true',
    provider: (process.env.SCALER_PROVIDER as ScalerConfig['provider']) || 'noop',
    minRunners,
    maxRunners,
    scaleUpThreshold: intEnv('SCALER_SCALE_UP_THRESHOLD', 5),
    idleTimeoutSecs: intEnv('SCALER_IDLE_TIMEOUT_SECS', 600),
    pollIntervalSecs: Math.max(1, intEnv('SCALER_POLL_INTERVAL_SECS', 30)),
    runsPerRunner: Math.max(1, intEnv('SCALER_RUNS_PER_RUNNER', 5)),
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
    case 'local-docker':
      provider = new LocalDockerProvider();
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

  if (process.env.SCALER_INSECURE_TLS === 'true') {
    console.warn(
      '[Scaler] ⚠️  SCALER_INSECURE_TLS=true — runners will be created with ' +
        'NODE_TLS_REJECT_UNAUTHORIZED=0. All outbound HTTPS from runners is ' +
        'MITM-vulnerable. Only set this for trusted internal CAs.'
    );
  }

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
  const heartbeatKeys = await scanKeys('runner:heartbeat:*');
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
