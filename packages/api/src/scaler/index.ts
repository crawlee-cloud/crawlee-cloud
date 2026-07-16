/**
 * Runner auto-scaler — monitors the run queue and scales runner
 * VMs up/down based on demand.
 *
 * Disabled by default (SCALER_ENABLED=false). When enabled, runs as
 * a background loop inside the API process. Has zero impact on
 * single-Droplet or docker-compose deployments.
 */

import { nanoid } from 'nanoid';
import type pg from 'pg';
import { query, withAdvisoryLock, LOCK_IDS } from '../db/index.js';
import { redis } from '../storage/redis.js';
import { putKVRecord } from '../storage/s3.js';
import type { RunnerProvider, RunnerInfo, ScalerConfig } from './types.js';
import { NoopProvider } from './providers/noop.js';
import { DigitalOceanProvider } from './providers/digitalocean.js';
import { LocalDockerProvider } from './providers/local-docker.js';

let provider: RunnerProvider;
let config: ScalerConfig;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isScaling = false;
let wasLeader: boolean | undefined = undefined;

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
 * Pure: only reads from `process.env` and the provided arguments.
 *
 * `priceHourly` is the droplet's hourly USD price resolved at scale-up
 * (operator override or DO /v2/sizes) — baked into the env file so
 * claimNextRun stamps it onto every run this droplet executes. Null →
 * line omitted → the runner's envFloatOrNull yields null ("not recorded").
 */
export function getCloudInitScript(
  runsPerRunner: number,
  priceHourly: number | null = null
): string {
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

  // Optional pin for the runner clone. When unset, falls back to default
  // branch (main) — historical behavior. Setting it to a tag (e.g.
  // 'v0.9.5') decouples runner upgrades from upstream main merges, so a
  // breaking change to runner-side runtime requirements (like the
  // v0.9.4 PROXY_ENCRYPTION_KEY requirement) doesn't auto-detonate the
  // cluster the next time the scaler spawns a droplet.
  //
  // Shell-safety: git considers shell metacharacters (`;`, `&`, backticks,
  // `$(...)`, `|`, newlines) valid in ref names — `git check-ref-format
  // --branch 'foo;bar'` exits 0. Embedding such a value into a bash heredoc
  // unquoted would run two commands on the droplet. Two layers of defense:
  //   1. Reject anything outside the safe charset before render time. The
  //      regex covers every real-world tag/branch we ship (alphanumeric,
  //      dot, underscore, slash, hyphen, plus).
  //   2. Single-quote the value in the rendered bash so any future regex
  //      loosening still can't escape its argument context.
  const cloneRef = (process.env.RUNNER_CLONE_REF || '').trim();
  if (cloneRef && !/^[A-Za-z0-9._/+-]+$/.test(cloneRef)) {
    throw new Error(
      `RUNNER_CLONE_REF contains characters outside the safe set [A-Za-z0-9._/+-]: ${JSON.stringify(cloneRef)}`
    );
  }
  const cloneRefFlag = cloneRef ? `--branch '${cloneRef}' ` : '';

  // Optional prebuilt runner image. When set, the droplet boots the runner
  // as a container instead of apt-install nodejs + git clone + npm install
  // + build — the cold path measured at ~4.5 minutes per scale-up in prod
  // (2026-07-13 audit: pickup latency p50 ~5min; the one day the pool was
  // pinned it was 24s). The 'docker-20-04' base image ships docker, so
  // pull+run is the only boot work left.
  //
  // Same shell-safety posture as RUNNER_CLONE_REF above: allow-list the
  // charset (image refs add ':' for tags and '@' for digests), then
  // single-quote at every use site.
  const runnerImage = (process.env.RUNNER_IMAGE || '').trim();
  if (runnerImage && !/^[A-Za-z0-9._/+:@-]+$/.test(runnerImage)) {
    throw new Error(
      `RUNNER_IMAGE contains characters outside the safe set [A-Za-z0-9._/+:@-]: ${JSON.stringify(runnerImage)}`
    );
  }

  // Shared between both boot modes: runner env file + RUNNER_ID pin.
  //
  // RUNNER_ID is pinned to the DO droplet id (queried from the metadata
  // service at boot). The runner uses RUNNER_ID as its Redis heartbeat
  // key; without this, it falls back to os.hostname() (the droplet
  // *name*), and the scaler — which looks up heartbeats by droplet id —
  // never matches it, so every runner is marked dead and reaped. The api
  // also matches by name as a fallback, so this curl failing isn't fatal.
  const envFileBlock = `# Configure runner
cat > /etc/crawlee-runner.env << 'ENVEOF'
DATABASE_URL=${dbUrl}
REDIS_URL=${redisUrl}
API_BASE_URL=${apiBaseUrl}
DOCKER_NETWORK=bridge
MAX_CONCURRENT_RUNS=${runsPerRunner}
DEFAULT_MEMORY_MB=${CLOUD_INIT_DEFAULT_MEMORY_MB}
DEFAULT_TIMEOUT_SECS=${CLOUD_INIT_DEFAULT_TIMEOUT_SECS}
LOG_LEVEL=info
RUNNER_PROVIDER=digitalocean
${priceHourly !== null ? `RUNNER_PRICE_HOURLY=${priceHourly}` : '# RUNNER_PRICE_HOURLY unresolved (lookup failed / no override)'}
IMAGE_REGISTRY=${process.env.IMAGE_REGISTRY || ''}
IMAGE_REGISTRY_USER=${process.env.IMAGE_REGISTRY_USER || ''}
IMAGE_REGISTRY_TOKEN=${process.env.IMAGE_REGISTRY_TOKEN || ''}
PROXY_ENCRYPTION_KEY=${process.env.PROXY_ENCRYPTION_KEY || ''}
${tlsEnvFileLine}
ENVEOF

# RUNNER_ID must resolve to something the scaler can match (droplet id,
# or droplet NAME via the heartbeat name-fallback). Retried because a
# transient metadata-service blip at boot otherwise left RUNNER_ID unset —
# fatal in the prebuilt-image mode, where the container's os.hostname()
# fallback is the container id, which matches nothing: the runner gets
# falsely dead-reaped and its runs can't be attributed. $(hostname) here
# evaluates on the HOST (= droplet name), never inside the container.
DO_ID=""
for i in 1 2 3; do DO_ID=$(curl -fsSL --max-time 5 http://169.254.169.254/metadata/v1/id 2>/dev/null) && break || sleep 2; done
echo "RUNNER_ID=\${DO_ID:-$(hostname)}" >> /etc/crawlee-runner.env

chmod 600 /etc/crawlee-runner.env`;

  const ghcrLoginBlock = ghcrToken
    ? `echo "${ghcrToken}" | docker login ghcr.io -u github --password-stdin`
    : '# No GHCR token';

  const readyBlock = `# Signal ready
curl -s -X POST "${apiBaseUrl}/v2/internal/runner-ready" -H "Content-Type: application/json" -d '{}' || true`;

  if (runnerImage) {
    return `#!/bin/bash
set -e

# Login to GHCR if configured (private runner image and/or actor images)
${ghcrLoginBlock}

${envFileBlock}

# Boot the prebuilt runner image. The host docker socket is mounted so
# the containerized runner can drive sibling actor containers — actor
# containers land on the HOST daemon, exactly as in the git-clone mode.
#
# Pull retries a few times: a transient registry blip at boot would
# otherwise strand the droplet as a billed-but-runnerless zombie. If the
# image still isn't present, the docker run below fails hard (set -e)
# rather than booting nothing silently.
#
# No extra TLS env flag on docker run: when SCALER_INSECURE_TLS=true the
# env-file already carries NODE_TLS_REJECT_UNAUTHORIZED into the container.
for i in 1 2 3; do docker pull '${runnerImage}' && break || sleep 10; done
# --oom-score-adj=-900: host OOM must sacrifice actor containers, never
# the runner (same rationale as OOMScoreAdjust in the systemd mode).
docker run -d --name crawlee-runner \\
  --restart=always \\
  --oom-score-adj=-900 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  --env-file /etc/crawlee-runner.env \\
  '${runnerImage}'

${readyBlock}
`;
  }

  return `#!/bin/bash
set -e
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Clone and build runner
git clone ${cloneRefFlag}https://github.com/crawlee-cloud/crawlee-cloud.git /opt/crawlee-cloud
cd /opt/crawlee-cloud
npm install
npm run build --workspace=@crawlee-cloud/runner

# Login to GHCR if configured (for pulling pre-built actor images)
${ghcrLoginBlock}

${envFileBlock}

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
# Host OOM must sacrifice actor containers (score 0), never the control
# plane: on 2026-07-16 the kernel picked the runner process on two
# memory-exhausted droplets — heartbeat died, droplets were dead-reaped,
# and their runs zombified. -900 keeps the runner alive so it can report
# the container OOM and keep supervising.
OOMScoreAdjust=-900
Environment=NODE_ENV=production
${tlsSystemdLine}
EnvironmentFile=/etc/crawlee-runner.env
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable crawlee-runner
systemctl start crawlee-runner

${readyBlock}
`;
}

// ---- Scaling logic ----

export interface QueueStats {
  ready: number;
  running: number;
  total: number;
  /**
   * Memory demand in DROPLET-SHARES, not MB: each run contributes
   * 1 / floor(perVmUsable / effectiveLimit) — the fraction of one VM its
   * limit occupies under INTEGER packing. An MB sum was the first
   * implementation and under-provisioned single-tenant classes: 2048MB
   * runs pack 1-per-VM on 3144MB-usable hosts (floor(3144/2048)=1), but
   * ceil(sumMB/usable) credited 1.53 of them per VM — 13 such runs got 9
   * droplets and 4 READY rows sat unclaimed with desired == current.
   * Optional so pure-function callers/tests keep count-only math.
   */
  readyRunnerShares?: number;
  runningRunnerShares?: number;
  /**
   * Age of the oldest ELIGIBLE READY run in ms (clock starts at
   * run_after for delayed retries) — drives the starvation escalation.
   */
  oldestReadyAgeMs?: number;
}

async function getQueueStats(): Promise<QueueStats> {
  // Effective per-run limit is clamped at what one VM can host
  // (runnerMemoryMb - reserve), so an oversized run (4096MB requested on
  // a 3912MB VM) costs exactly one whole runner — floor() then gives its
  // share as 1/1. Matches the runner-side clampMemoryToHost/claimNextRun.
  const usableMb = Math.max(
    256,
    (config?.runnerMemoryMb ?? 3912) - (config?.memoryReserveMb ?? 768)
  );
  // READY rows gated on eligibility: a delayed retry (run_after in the
  // future) is invisible to every claim gate, so counting it as demand
  // provisions droplets that can do nothing with it — and its wait clock
  // must start at eligibility, not insert.
  const result = await query<{
    status: string;
    count: string;
    runner_shares: string | null;
    oldest_eligible: Date | null;
  }>(
    `SELECT status, COUNT(*) as count,
            SUM(1.0 / GREATEST(1, FLOOR($2::numeric / LEAST(COALESCE(memory_mbytes, $1), $2)))) as runner_shares,
            MIN(GREATEST(created_at, COALESCE(run_after, created_at))) as oldest_eligible
     FROM runs
     WHERE status = 'RUNNING'
        OR (status = 'READY' AND (run_after IS NULL OR run_after <= NOW()))
     GROUP BY status`,
    [CLOUD_INIT_DEFAULT_MEMORY_MB, usableMb]
  );

  const stats: QueueStats = { ready: 0, running: 0, total: 0 };
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    // Defensive: mocks/older shapes may omit the shares column — degrade
    // to 0 (count-only demand) rather than NaN-poisoning the desired calc.
    const shares = row.runner_shares != null ? parseFloat(row.runner_shares) : 0;
    if (row.status === 'READY') {
      stats.ready = count;
      stats.readyRunnerShares = Number.isFinite(shares) ? shares : 0;
      if (row.oldest_eligible) {
        stats.oldestReadyAgeMs = Math.max(0, Date.now() - new Date(row.oldest_eligible).getTime());
      }
    }
    if (row.status === 'RUNNING') {
      stats.running = count;
      stats.runningRunnerShares = Number.isFinite(shares) ? shares : 0;
    }
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
  cfg: ScalerConfig,
  /**
   * Zombie-filtered RUNNING count (heartbeat-claimed + fresh pickups),
   * i.e. `countLiveRunning(...)`. When provided, demand uses it instead
   * of the raw DB `stats.running` so orphaned RUNNING rows can't pin
   * capacity (live incident 2026-07-13: 12 zombies held desired at 9,
   * keeping 10 droplets alive with 0 real work on most of them). Omit
   * to preserve the raw-DB behavior.
   */
  liveRunningCount?: number,
  /**
   * Memory demand of live RUNNING rows in droplet-SHARES (see
   * QueueStats.readyRunnerShares). When provided, the runner count must
   * ALSO cover ceil(total shares): headcount packing alone placed 2 x
   * 2048MB limits (or one 4096MB limit) on 3912MB-usable droplets and
   * host-OOM-wedged two of them on 2026-07-16. Zombie-filtered by the
   * caller. Omit for count-only math.
   */
  liveRunningShares?: number,
  /**
   * True when some runner currently has zero active runs (idle, or still
   * booting with no heartbeat yet). Gates the starvation escalation:
   * while a rescue droplet boots (~5min), the starved state persists for
   * many ticks and would otherwise add one droplet PER TICK.
   */
  hasIdleOrBootingRunner?: boolean
): number {
  // Defensive coercion. `stats.ready` / `stats.running` come from parseInt
  // of a PG COUNT(*) result; under normal operation they're finite
  // non-negative integers, but a malformed row or future query change
  // shouldn't be able to feed NaN/negative numbers into a function that
  // decides how many droplets to spawn. Same for `currentRunners`, which
  // is `runners.length` after reaping — finite by construction, but the
  // guard costs nothing.
  const rawRunning = liveRunningCount ?? stats.running;
  const ready = Math.max(0, Number.isFinite(stats.ready) ? stats.ready : 0);
  const running = Math.max(0, Number.isFinite(rawRunning) ? rawRunning : 0);
  const current = Math.max(0, Number.isFinite(currentRunners) ? currentRunners : 0);
  const totalDemand = ready + running;

  if (totalDemand === 0) {
    return cfg.minRunners;
  }

  // Memory dimension: ceil of the droplet-share sum — integer bin
  // packing per size class (see QueueStats.readyRunnerShares for why an
  // MB sum under-provisions single-tenant classes). Uses the zombie-
  // filtered running shares when provided (a zombie's limit is not real
  // demand, same reasoning as liveRunningCount). The 1e-6 epsilon
  // absorbs float noise from fractional shares: 6 x 1/6 can sum to
  // 1.0000000000000002, which must not become 2 droplets.
  let neededByMemory = 0;
  const readyShares = Math.max(0, stats.readyRunnerShares ?? 0);
  const runningShares = Math.max(0, liveRunningShares ?? stats.runningRunnerShares ?? 0);
  if (readyShares + runningShares > 0) {
    neededByMemory = Math.ceil(readyShares + runningShares - 1e-6);
  }

  const needed = Math.max(Math.ceil(totalDemand / cfg.runsPerRunner), neededByMemory);
  const clamped = Math.max(cfg.minRunners, Math.min(needed, cfg.maxRunners));

  // Starvation escalation: once the oldest ELIGIBLE READY run has waited
  // past maxReadyWaitSecs, pressure is real regardless of batch size or
  // what the packing estimate says. Two live incident shapes it covers:
  //  - 2026-07-16 00:01: 3 READY runs waited 46-64 min because
  //    ready(3) <= threshold(5) froze scale-up until the 01:00 batch.
  //  - Packing residue: a run whose limit fits no busy droplet's
  //    headroom is claimable only by an IDLE droplet (claimNextRun's
  //    null gate), and share math can honestly say desired == current
  //    while it starves behind small-run churn. Forcing one extra
  //    droplet manufactures an idle claimant; the idle-timeout
  //    scale-down reclaims it afterward.
  const starving = ready > 0 && (stats.oldestReadyAgeMs ?? 0) > cfg.maxReadyWaitSecs * 1000;

  // Escalate ONLY when nothing idle/booting exists: a booting rescue
  // droplet has no heartbeat yet (activeRuns 0), which both suppresses
  // repeat bumps during its ~5min boot and means a persistent idle-but-
  // not-claiming droplet (wedged) is the dead reaper's job, not ours.
  if (starving && clamped <= current && current < cfg.maxRunners && !hasIdleOrBootingRunner) {
    return current + 1;
  }

  // Hysteresis: when queue pressure is below the scale-up threshold, freeze
  // the count — but ONLY in the upward direction. A draining long-tail
  // (running > 0, ready == 0) MUST be able to release capacity once fewer
  // runners are needed; otherwise a zombie RUNNING row or a slow finish
  // pins the cluster at high-water indefinitely (live-repro v0.9.8: 5+
  // hours at desired=10 with ready=0, running=2). The `current >= min`
  // clause preserves the cold-start floor: when we're below min, the
  // floor wins even if ready ≤ threshold.
  if (
    ready <= cfg.scaleUpThreshold &&
    clamped > current &&
    current >= cfg.minRunners &&
    !starving
  ) {
    return current;
  }

  return clamped;
}

async function getActiveRunners(): Promise<{
  runners: RunnerInfo[];
  /**
   * Union of run IDs claimed by ANY live heartbeat — the canonical
   * "this work has a live owner" signal. Used by scalingLoop to
   * distinguish a fresh-pickup race from a zombie RUNNING row.
   */
  claimedRunIds: Set<string>;
}> {
  // Don't swallow listRunners errors here — a transient API failure that
  // returns [] would let calculateDesiredRunners think we have zero capacity
  // and over-provision on the next tick. Let the caller (scalingLoop) abort
  // the tick instead so we act on real data only.
  const runners = await provider.listRunners();

  // Enrich runners with real metrics from heartbeats. We also capture
  // `runIds` per heartbeat — used by scalingLoop's activity gate to tell
  // a real RUNNING row apart from a zombie. Older runner builds that
  // pre-date the runIds field still publish all the other metrics; their
  // `runIds` is treated as `[]` and falls back to the `started_at` grace
  // window in scalingLoop.
  const heartbeatKeys = await scanKeys('runner:heartbeat:*');
  const heartbeats = new Map<
    string,
    {
      activeRuns: number;
      healthy: boolean;
      cpuUsage: number;
      memoryUsageRatio: number;
      runIds: string[];
    }
  >();
  const claimedRunIds = new Set<string>();

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
          runIds?: string[];
        };
        const runIds = Array.isArray(hb.runIds) ? hb.runIds : [];
        heartbeats.set(hb.runnerId, { ...hb, runIds });
        for (const id of runIds) claimedRunIds.add(id);
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
  const heartbeatMatchedIds = new Set<string>();
  for (const runner of runners) {
    const hb =
      heartbeats.get(runner.id) ||
      heartbeats.get(runner.ip) ||
      (runner.name ? heartbeats.get(runner.name) : undefined);
    if (hb) {
      heartbeatMatchedIds.add(runner.id);
      runner.activeRuns = hb.activeRuns;
      runner.status = hb.activeRuns > 0 ? 'busy' : 'ready';
      // Mark unhealthy runners
      if (!hb.healthy || hb.memoryUsageRatio > 0.95 || hb.cpuUsage > 0.95) {
        runner.status = 'draining';
      }
    }
    // No heartbeat → handled below by consecutive-miss dead detection.
    // Boot-grace and condemnation thresholds live in
    // evaluateDeadCandidates; see its doc comment for why a single
    // missing heartbeat must never condemn a runner.
  }

  // Miss counters must survive across ticks (each tick is a fresh call),
  // across scaler restarts, and across leadership handoffs between API
  // instances — so they live in Redis, not process memory. A lost/expired
  // counter map degrades safely: counting restarts from zero, which
  // delays reaping by a few ticks rather than causing a false destroy.
  const missKey = 'scaler:hb-misses';
  let prevMisses: Record<string, number | MissEntry> = {};
  try {
    const raw = await redis.get(missKey);
    if (raw) {
      // JSON.parse doesn't throw on "null"/"3"/"[...]" — it returns a
      // non-object that would TypeError on property access downstream,
      // aborting every tick until the key's TTL clears it (the
      // corrective write never runs because the crash comes first).
      // Non-object shapes degrade the same way as unparseable JSON.
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prevMisses = parsed as Record<string, number | MissEntry>;
      }
    }
  } catch {
    // Corrupt state → start counting fresh (conservative direction).
  }

  const { deadIds, nextMisses } = evaluateDeadCandidates(runners, heartbeatMatchedIds, prevMisses, {
    deadAfterMs: intEnv('SCALER_REAPER_DEAD_AFTER_SECS', 180) * 1000,
    missThreshold: intEnv('SCALER_REAPER_MISS_TICKS', 3),
    // Default = the heartbeat TTL (90s): guarantees the runner had a
    // full TTL window to get one beat through before condemnation,
    // regardless of how fast ticks interleave across replicas.
    missWindowMs: intEnv('SCALER_REAPER_MISS_WINDOW_SECS', 90) * 1000,
    now: Date.now(),
  });

  for (const runner of runners) {
    if (deadIds.has(runner.id)) {
      // Distinct from 'draining' (alive but stressed) so the reaper
      // can destroy it without conflating with demand-based scale-down.
      runner.status = 'dead';
    }
  }

  // TTL >> tick interval so counters persist between ticks, but stale
  // maps from a long scaler outage self-clean instead of condemning
  // runners with pre-outage counts the moment the scaler comes back.
  // Write is best-effort: a set-only Redis failure must not abort the
  // tick — losing the map just restarts counting (the read above is
  // already guarded in the same conservative direction).
  try {
    await redis.set(missKey, JSON.stringify(nextMisses), 'EX', 900);
  } catch (err) {
    console.warn(`[Scaler] Failed to persist heartbeat-miss map:`, (err as Error).message);
  }

  return { runners, claimedRunIds };
}

/**
 * Consecutive-miss + time-window dead detection.
 *
 * A missing heartbeat key is weak evidence: the key has a 90s TTL and
 * lives in Redis, so a managed-Redis failover/restart (or a runner-side
 * Redis reconnect) makes the entire fleet look dead for one tick even
 * though every droplet is fine. Pre-v1.0.2 the scaler hard-destroyed on
 * that single tick — one nightly Redis blip massacred the busy fleet and
 * orphaned every claimed run as an immortal zombie RUNNING row (live
 * incident, four nights 2026-07-09..12).
 *
 * A runner is condemned only when BOTH hold, and only once it is past
 * the `deadAfterMs` boot grace:
 *   - `missThreshold` CONSECUTIVE observations without a heartbeat, AND
 *   - at least `missWindowMs` of wall-clock time since the FIRST miss.
 * The count alone is not enough: the scaler's advisory lock is a
 * per-tick try-lock, so N API replicas with offset timers can interleave
 * N ticks per poll interval — 3 misses can accumulate in ~20s, which
 * would re-open the single-blip massacre through the counter itself.
 * The time window guarantees the runner had a full heartbeat-TTL span
 * to get a beat through, regardless of tick cadence.
 *
 * Any heartbeat resets its entry. Counters for runners no longer
 * reported by the provider are pruned.
 *
 * Pure function: caller owns persistence of the miss map (Redis, so the
 * state survives leader hand-offs between API replicas).
 */
export interface DeadDetectionOptions {
  /** Boot grace: runners younger than this never accrue misses. */
  deadAfterMs: number;
  /** Consecutive missed observations required before a runner is 'dead'. */
  missThreshold: number;
  /** Minimum wall-clock time since the first miss before condemnation. */
  missWindowMs: number;
  now: number;
}

/** Persisted miss-map entry: consecutive miss count + first-miss epoch ms. */
export interface MissEntry {
  c: number;
  t: number;
}

export function evaluateDeadCandidates(
  runners: { id: string; createdAt: Date }[],
  heartbeatMatchedIds: Set<string>,
  // `number` values are the legacy pre-window format still possibly
  // persisted in Redis across a deploy — tolerated on read, never written.
  prevMisses: Record<string, number | MissEntry>,
  opts: DeadDetectionOptions
): { deadIds: Set<string>; nextMisses: Record<string, MissEntry> } {
  const deadIds = new Set<string>();
  const nextMisses: Record<string, MissEntry> = {};

  for (const runner of runners) {
    if (heartbeatMatchedIds.has(runner.id)) continue; // alive — entry resets by omission

    const ageMs = opts.now - runner.createdAt.getTime();
    if (ageMs <= opts.deadAfterMs) continue; // still booting — no misses accrue

    const prev = prevMisses[runner.id];
    let entry: MissEntry;
    if (typeof prev === 'number' && Number.isFinite(prev)) {
      // Legacy plain-count entry: keep the count but restart the clock —
      // conservative (delays condemnation by at most one window) and the
      // only safe choice since the legacy shape has no firstMissAt.
      entry = { c: prev + 1, t: opts.now };
    } else if (
      prev &&
      typeof prev === 'object' &&
      Number.isFinite(prev.c) &&
      Number.isFinite(prev.t)
    ) {
      entry = { c: prev.c + 1, t: prev.t };
    } else {
      entry = { c: 1, t: opts.now };
    }
    nextMisses[runner.id] = entry;

    if (entry.c >= opts.missThreshold && opts.now - entry.t >= opts.missWindowMs) {
      deadIds.add(runner.id);
    }
  }

  return { deadIds, nextMisses };
}

/**
 * Grace window for RUNNING rows whose runner hasn't heartbeated since
 * pickup. The runner heartbeats every 30s; we allow 3 intervals before
 * declaring a RUNNING row a zombie, which tolerates one missed beat
 * without false-idling fresh pickups. See the comment block in
 * `scalingLoop` for the full race-vs-zombie reasoning.
 */
export const PICKUP_GRACE_MS = 90_000;

/**
 * Count of RUNNING rows that represent real work (not zombies), given
 * heartbeat claims and a fresh-pickup grace window. Pure function over
 * input rows; queries the DB at most once per tick from the caller.
 *
 * Exported for unit testing in isolation from the DB.
 */
export function countLiveRunning(
  runningRows: { id: string; started_at: Date | null }[],
  claimedRunIds: Set<string>,
  now: number = Date.now()
): number {
  let count = 0;
  for (const row of runningRows) {
    if (isLiveRunningRow(row, claimedRunIds, now)) count++;
  }
  return count;
}

/**
 * The single liveness predicate shared by demand counting and memory
 * demand: a RUNNING row is real work if a live heartbeat claims it, or it
 * started within the pickup grace window (claim may not have landed in a
 * heartbeat yet). Everything else is a zombie.
 */
function isLiveRunningRow(
  row: { id: string; started_at: Date | null },
  claimedRunIds: Set<string>,
  now: number
): boolean {
  if (claimedRunIds.has(row.id)) return true;
  return row.started_at != null && now - new Date(row.started_at).getTime() < PICKUP_GRACE_MS;
}

/**
 * Zombie-filtered memory demand of RUNNING rows, in droplet-SHARES. Each
 * live row contributes 1 / floor(usable / effectiveLimit) — the fraction
 * of one VM its limit occupies under integer packing — mirroring
 * getQueueStats' SQL so READY and RUNNING demand are in the same units.
 * (An MB sum under-provisioned single-tenant classes: floor(3144/2048)=1
 * means one 2048MB run costs a whole droplet, not 2048/3144 of one.)
 * Exported for unit tests.
 */
export function liveRunningShares(
  runningRows: { id: string; started_at: Date | null; memory_mbytes?: number | null }[],
  claimedRunIds: Set<string>,
  opts: { defaultMemoryMb: number; usableMemoryMb: number },
  now: number = Date.now()
): number {
  let shares = 0;
  for (const row of runningRows) {
    if (!isLiveRunningRow(row, claimedRunIds, now)) continue;
    const effMb = Math.min(row.memory_mbytes ?? opts.defaultMemoryMb, opts.usableMemoryMb);
    shares += 1 / Math.max(1, Math.floor(opts.usableMemoryMb / Math.max(1, effMb)));
  }
  return shares;
}

/**
 * Rows eligible for zombie-run reaping. Shape matches the one SELECT in
 * `fetchRunningRows` so the demand count and the reaper share a single
 * DB round-trip per tick.
 */
export interface RunningRow {
  id: string;
  started_at: Date | null;
  timeout_secs: number | null;
  /** Requested container memory limit — feeds memory-aware demand. */
  memory_mbytes?: number | null;
}

/**
 * Identify zombie RUNNING rows: runs whose owning runner died without
 * issuing the terminal UPDATE. `timeout_secs` is enforced ONLY by the
 * owning runner (docker stop → exit 143 → TIMED-OUT), so when that
 * runner is destroyed the row overruns forever — the 2026-07-13 incident
 * had rows RUNNING for 4 days against a 3600s timeout.
 *
 * A run is a zombie only when BOTH hold:
 *   - no live heartbeat claims it (owner is gone, not just between beats)
 *   - it has outlived its own timeout + PICKUP_GRACE_MS (even a healthy
 *     owner would have killed it by now, so reaping can't race a
 *     legitimate finish — the `WHERE status='RUNNING'` guard on the
 *     UPDATE covers the residual window)
 *
 * Runs claimed by a live heartbeat are NEVER reaped here, however old:
 * timeout enforcement for owned runs belongs to the owning runner, and
 * double-enforcement would race its terminal UPDATE.
 */
export function findZombieRuns(
  rows: RunningRow[],
  claimedRunIds: Set<string>,
  now: number = Date.now()
): string[] {
  const zombies: string[] = [];
  for (const row of rows) {
    if (claimedRunIds.has(row.id)) continue;
    if (!row.started_at) continue; // cannot judge age — leave for operators
    const timeoutMs = (row.timeout_secs ?? 3600) * 1000;
    if (now - new Date(row.started_at).getTime() > timeoutMs + PICKUP_GRACE_MS) {
      zombies.push(row.id);
    }
  }
  return zombies;
}

/**
 * One SELECT per tick feeding BOTH consumers of RUNNING-row state:
 * `countLiveRunning` (zombie-filtered demand) and `findZombieRuns`
 * (the reaper). Skips the query entirely when there are no RUNNING
 * rows to evaluate — saves a round-trip on the common quiet tick.
 *
 * The SELECT is bounded: there can be at most `maxRunners * runsPerRunner`
 * RUNNING rows at any time, so this stays well under a dozen rows for
 * default configs.
 */
async function fetchRunningRows(reportedRunning: number): Promise<RunningRow[]> {
  if (reportedRunning <= 0) return [];
  const result = await query<RunningRow>(
    `SELECT id, started_at, timeout_secs, memory_mbytes FROM runs WHERE status = 'RUNNING'`
  );
  return result.rows;
}

/**
 * Terminalize zombie runs (see `findZombieRuns`) and enqueue their
 * TIMED_OUT webhooks. Runs under the scaler advisory lock, so at most
 * one API instance reaps per tick. The lock's pinned `client` is used
 * for a single transaction wrapping the terminal UPDATE and the webhook
 * enqueue — a crash between the two previously lost the TIMED_OUT
 * delivery forever, since the run was no longer RUNNING and no later
 * tick would re-discover it.
 *
 * The `AND status = 'RUNNING'` guard makes the UPDATE a no-op for any
 * run whose owner terminalized it between our SELECT and now — same
 * lifecycle invariant the runner relies on (queue.ts terminal UPDATE).
 *
 * Accepted at-least-once window: an owner that is alive but heartbeat-
 * invisible (e.g. runner-side Redis outage) can still terminalize its
 * run late and enqueue its own webhook — producing a duplicate
 * TIMED_OUT delivery. The status guard prevents state clobbering, and
 * webhook delivery is at-least-once by design, so the duplicate is
 * accepted rather than raced against.
 */
async function reapZombieRuns(client: pg.PoolClient, zombieIds: string[]): Promise<void> {
  if (zombieIds.length === 0) return;

  let reaped: { id: string; actor_id: string; default_key_value_store_id: string | null }[] = [];
  try {
    await client.query('BEGIN');
    // finished_at is the run's own deadline, not NOW(): zombies are
    // discovered hours-to-days after their runner died, and stamping the
    // reap moment made an 8h-dead run display an 8h runtime against a
    // 3600s timeout (and skewed duration stats). Apify semantics: a
    // timed-out run finishes at its timeout. started_at is always set
    // here — findZombieRuns skips ageless rows.
    const updated = await client.query<{
      id: string;
      actor_id: string;
      default_key_value_store_id: string | null;
    }>(
      `UPDATE runs
       SET status = 'TIMED-OUT',
           finished_at = started_at + (COALESCE(timeout_secs, 3600) * interval '1 second'),
           modified_at = NOW(),
           status_message = 'Runner lost before completion; reaped by scaler after timeout overrun'
       WHERE id = ANY($1) AND status = 'RUNNING'
       RETURNING id, actor_id, default_key_value_store_id`,
      [zombieIds]
    );

    // Unlike the runner's insert (next_retry_at = NULL + synchronous
    // first attempt), the API has no delivery worker — next_retry_at =
    // NOW() hands the row to any live runner's retry processor, which
    // claims PENDING rows with next_retry_at <= NOW() every 10s and
    // re-renders the payload from the DB. No runner alive right now →
    // delivered when one boots.
    //
    // Known limit: in a scale-to-zero deployment (SCALER_MIN_RUNNERS=0)
    // that goes idle after the reap, the PENDING row waits until the
    // next runner boots for any reason — pending deliveries don't count
    // as scaler demand. Accepted for now: runners are the only component
    // holding webhook delivery semantics (template render, attempt
    // bookkeeping, retry backoff), and duplicating that here for a
    // corner case isn't worth the drift risk. Revisit if an API-side
    // delivery worker ever exists.
    //
    await enqueueRunEventWebhooks(client, updated.rows, 'ACTOR.RUN.TIMED_OUT');
    await client.query('COMMIT');
    reaped = updated.rows;
  } catch (err) {
    // Roll back so the runs stay RUNNING and the next tick retries the
    // whole reap — partial state (terminalized run, no webhook row) is
    // exactly what the transaction exists to prevent. Never abort the
    // tick over it.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection-level failure; withAdvisoryLock's release handles it.
    }
    console.error(`[Scaler] Zombie-run reap transaction failed:`, (err as Error).message);
    return;
  }
  if (reaped.length === 0) return;

  console.log(
    `[Scaler] Reaped ${reaped.length} zombie run(s): ${reaped.map((r) => r.id).join(', ')}`
  );

  await archiveOrphanedRunLogs(reaped);
}

/**
 * Enqueue PENDING webhook deliveries for a batch of terminalized runs.
 * Must be called INSIDE the caller's open transaction, before COMMIT —
 * losing the delivery row after the terminal UPDATE commits means the
 * event is never delivered (no later tick re-discovers terminal runs).
 *
 * One SELECT for the whole batch, actor/run scoping applied in memory:
 * the caller's transaction holds locks on the terminalized `runs` rows,
 * so per-run round-trips (N+1) would stretch the lock window for no
 * benefit — the enabled-webhook set is small by nature.
 */
async function enqueueRunEventWebhooks(
  client: pg.PoolClient,
  runs: { id: string; actor_id: string }[],
  eventType: 'ACTOR.RUN.TIMED_OUT' | 'ACTOR.RUN.FAILED'
): Promise<void> {
  if (runs.length === 0) return;
  const webhooks = await client.query<{
    id: string;
    actor_id: string | null;
    run_id: string | null;
  }>(
    `SELECT id, actor_id, run_id FROM webhooks
     WHERE is_enabled = true AND $1 = ANY(event_types)`,
    [eventType]
  );
  for (const run of runs) {
    const matched = webhooks.rows.filter(
      (w) =>
        (w.actor_id === null || w.actor_id === run.actor_id) &&
        (w.run_id === null || w.run_id === run.id)
    );
    for (const webhook of matched) {
      await client.query(
        `INSERT INTO webhook_deliveries (id, webhook_id, run_id, event_type, status, attempt_count, max_attempts, next_retry_at)
         VALUES ($1, $2, $3, $4, 'PENDING', 0, 5, NOW())`,
        [nanoid(), webhook.id, run.id, eventType]
      );
    }
  }
}

/**
 * Salvage whatever log tail is still in Redis before its 24h TTL takes
 * the only evidence of what a run was doing when its runner died —
 * 4-day-old zombies in the 2026-07-13 incident were un-autopsiable.
 * The owning runner is gone by definition, so nobody else will archive
 * these. Best-effort and deliberately called AFTER the terminalizing
 * commit: never let archival break (or roll back) a reap.
 */
async function archiveOrphanedRunLogs(
  runs: { id: string; default_key_value_store_id: string | null }[]
): Promise<void> {
  for (const run of runs) {
    if (!run.default_key_value_store_id) continue;
    try {
      const lines = await redis.lrange(`logs:${run.id}`, 0, -1);
      if (lines.length === 0) continue;
      const text = lines
        .map((raw) => {
          try {
            const e = JSON.parse(raw) as { timestamp?: string; level?: string; message?: string };
            return `${e.timestamp ?? ''} ${e.level ?? ''} ${e.message ?? ''}`.trim();
          } catch {
            return raw;
          }
        })
        .join('\n');
      await putKVRecord(
        run.default_key_value_store_id,
        'RUN_LOG.txt',
        text,
        'text/plain; charset=utf-8'
      );
    } catch (err) {
      console.error(
        `[Scaler] Failed to archive logs for reaped run ${run.id}:`,
        (err as Error).message
      );
    }
  }
}

/**
 * Immediately terminalize the RUNNING runs of runners that were just
 * dead-reaped (droplet destroyed). Before this, a dead runner's runs
 * stayed falsely RUNNING until their own timeout deadline — 1h23m of
 * known-false state in the 2026-07-16 incident — inflating demand and
 * delaying downstream retries. Attribution is the claim-time `runner_id`
 * stamp; runs claimed by pre-stamping runner builds have runner_id NULL
 * and fall through to the deadline-based zombie reaper as before.
 *
 * Safe by construction: this fires only AFTER provider.destroyRunner()
 * succeeded for that runner id, so the containers demonstrably no longer
 * exist — unlike the deadline reaper there is no live-owner race to
 * respect. Same transactional shape as reapZombieRuns (terminal UPDATE +
 * webhook enqueue commit together; status guard makes it a no-op for
 * runs whose owner terminalized them first). FAILED (not TIMED-OUT):
 * the run did not overrun anything — its host died under it.
 */
async function failRunsOfDeadRunners(client: pg.PoolClient, runnerIds: string[]): Promise<void> {
  if (runnerIds.length === 0) return;

  let reaped: { id: string; actor_id: string; default_key_value_store_id: string | null }[] = [];
  try {
    await client.query('BEGIN');
    const updated = await client.query<{
      id: string;
      actor_id: string;
      default_key_value_store_id: string | null;
    }>(
      `UPDATE runs
       SET status = 'FAILED',
           finished_at = NOW(),
           modified_at = NOW(),
           status_message = 'Runner host died (heartbeat lost); run terminated when the scaler destroyed the host'
       WHERE runner_id = ANY($1) AND status = 'RUNNING'
       RETURNING id, actor_id, default_key_value_store_id`,
      [runnerIds]
    );
    await enqueueRunEventWebhooks(client, updated.rows, 'ACTOR.RUN.FAILED');
    await client.query('COMMIT');
    reaped = updated.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection-level failure; withAdvisoryLock's release handles it.
    }
    // Non-fatal: the runs stay RUNNING and the deadline-based zombie
    // reaper terminalizes them later, as before this fast path existed.
    console.error(`[Scaler] Dead-runner run reap failed:`, (err as Error).message);
    return;
  }
  if (reaped.length === 0) return;

  console.log(
    `[Scaler] Failed ${reaped.length} run(s) of dead runner(s) ${runnerIds.join(', ')}: ${reaped.map((r) => r.id).join(', ')}`
  );
  await archiveOrphanedRunLogs(reaped);
}

async function scaleUp(count: number): Promise<void> {
  console.log(`[Scaler] Scaling UP: creating ${count} runner(s)`);

  // Resolve the droplet's hourly price once per scale-up batch: operator
  // override first (SCALER_PRICE_HOURLY_OVERRIDE — the pool is single-
  // sized), then the provider's pricing API (DO /v2/sizes, cached 24h).
  // Price is captured claim-time-only by design (droplets are destroyed at
  // scale-down and DO reprices), so a run provisioned without a price is
  // permanently "not recorded" — but a lookup failure must never block
  // droplet creation, so null is the degraded mode, not an error.
  const overrideRaw = Number.parseFloat(process.env.SCALER_PRICE_HOURLY_OVERRIDE ?? '');
  const priceHourly =
    Number.isFinite(overrideRaw) && overrideRaw >= 0
      ? overrideRaw
      : ((await provider.getHourlyPrice?.(config.runnerSize).catch(() => null)) ?? null);
  if (priceHourly === null) {
    console.warn(
      `[Scaler] No hourly price for size ${config.runnerSize} — runs on the new droplet(s) will be stamped "price not recorded"`
    );
  }

  for (let i = 0; i < count; i++) {
    try {
      const runner = await provider.createRunner({
        region: config.runnerRegion,
        size: config.runnerSize,
        sshKeyId: config.sshKeyId,
        userData: getCloudInitScript(config.runsPerRunner, priceHourly),
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
async function reapDeadRunners(
  runners: RunnerInfo[]
): Promise<{ survivors: RunnerInfo[]; reapedIds: string[] }> {
  const dead = runners.filter((r) => r.status === 'dead');
  if (dead.length === 0) return { survivors: runners, reapedIds: [] };

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
  return {
    survivors: runners.filter((r) => !reaped.has(r.id)),
    // Only SUCCESSFULLY destroyed runners: failRunsOfDeadRunners' safety
    // argument rests on the containers being provably gone.
    reapedIds: [...reaped],
  };
}

async function scalingLoop(): Promise<void> {
  if (isScaling) return; // intra-replica re-entrancy fast-path
  isScaling = true;
  try {
    const r = await withAdvisoryLock(LOCK_IDS.scaler, async (client) => {
      const stats = await getQueueStats();
      const active = await getActiveRunners();
      const { claimedRunIds } = active;
      // `runners` is rebound after reaping; `claimedRunIds` stays as-is.
      // Split this way (rather than `let { runners, claimedRunIds } = ...`)
      // so `prefer-const` is satisfied for the immutable half.
      const reap = await reapDeadRunners(active.runners);
      const runners = reap.survivors;
      const currentCount = runners.length;

      // Terminalize the destroyed runners' RUNNING rows NOW (attribution
      // via the claim-time runner_id stamp) instead of letting them sit
      // falsely RUNNING until their timeout deadline. Before
      // fetchRunningRows on purpose: the freshly-failed rows must not
      // count as running demand or zombie candidates this tick.
      await failRunsOfDeadRunners(client, reap.reapedIds);

      // Zombie-filtered RUNNING count, computed BEFORE the desired calc so
      // both demand and the activity gate share one source of truth. Before
      // v1.0.2 only the activity gate was zombie-aware: 12 orphaned RUNNING
      // rows (2026-07-13) inflated desired to 9 and pinned a mostly-idle
      // 10-droplet pool that the idle gate could never drain.
      const runningRows = await fetchRunningRows(stats.running);
      const realRunningCount = countLiveRunning(runningRows, claimedRunIds);
      const liveShares = liveRunningShares(runningRows, claimedRunIds, {
        defaultMemoryMb: CLOUD_INIT_DEFAULT_MEMORY_MB,
        usableMemoryMb: Math.max(256, config.runnerMemoryMb - config.memoryReserveMb),
      });
      // Idle/booting detection feeds the starvation escalation: activeRuns
      // is heartbeat-enriched in getActiveRunners; a booting droplet has
      // no heartbeat yet and keeps the provider default of 0.
      const hasIdleOrBootingRunner = runners.some(
        (r) => r.activeRuns === 0 || r.status === 'creating'
      );
      const desired = calculateDesiredRunners(
        stats,
        currentCount,
        config,
        realRunningCount,
        liveShares,
        hasIdleOrBootingRunner
      );

      // RUNNING rows without started_at are invisible to the zombie
      // reaper (findZombieRuns can't judge their age and skips them) and
      // to the pickup-grace path — they'd otherwise linger silently
      // forever. Surface them each tick so operators can close them out.
      const noStartRows = runningRows.filter((row) => !row.started_at);
      if (noStartRows.length > 0) {
        console.warn(
          `[Scaler] ${noStartRows.length} RUNNING row(s) have null started_at and are skipped by the zombie reaper: ${noStartRows.map((row) => row.id).join(', ')}`
        );
      }

      // Terminalize runs whose owner is gone AND whose own timeout has
      // lapsed. Without this, `timeout_secs` is enforced by nobody once
      // the owning runner dies — prod had rows RUNNING for 4 days against
      // a 3600s timeout (2026-07-13). Reuses this tick's rows + claims,
      // and the advisory-lock client for the reap transaction.
      await reapZombieRuns(client, findZombieRuns(runningRows, claimedRunIds));

      // "Activity" must reflect physical reality, not DB-status alone, and
      // must NOT false-idle during a legitimate pickup-vs-heartbeat race.
      //
      // The naive gate `stats.total > 0` (pre-v0.9.9) refreshed activity
      // whenever the DB had any non-terminal row — including zombies whose
      // owning runner had died before issuing the terminal UPDATE (see
      // packages/runner/src/queue.ts:361 lifecycle invariant). That kept
      // `idleMs` near zero forever and pinned the cluster.
      //
      // The first v0.9.9 attempt — `stats.ready > 0 || runners.some(r =>
      // r.activeRuns > 0)` — fixed zombies but reopened a race window:
      // when an idle cluster picks up a fresh run via Redis pub-sub
      // (sub-second), the DB flips to RUNNING immediately, but the
      // runner's most recent heartbeat (up to ~30s old) still reports
      // `activeRuns: 0`. In that window the gate would evaluate false
      // and, if `idleMs > idleTimeoutSecs`, scaleDown could destroy the
      // just-busy runner mid-pickup.
      //
      // The correct gate cross-references the two sources of truth:
      //   - DB: which run IDs are RUNNING right now? When did they start?
      //   - Heartbeats: which run IDs do live runners claim?
      // A RUNNING row counts as real work if either (a) a live heartbeat
      // claims it, or (b) it started within `PICKUP_GRACE_MS` and the
      // claim simply hasn't landed yet. Older runs with no live claim are
      // zombies and don't count. (`realRunningCount` is computed above,
      // before the desired calc, and shared with it.)
      const realActivity = stats.ready > 0 || realRunningCount > 0;
      if (realActivity) {
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

      if (stats.total > 0 || currentCount > config.minRunners) {
        // Surface zombie divergence in the one log line operators watch.
        // "N running (M zombie)" was the missing signal in the 2026-07-13
        // incident — raw DB count and live-claimed count disagreed for
        // four days with no visible trace.
        const zombieCount = stats.running - realRunningCount;
        const runningLabel =
          zombieCount > 0
            ? `${stats.running} running (${zombieCount} zombie)`
            : `${stats.running} running`;
        console.log(
          `[Scaler] Queue: ${stats.ready} ready, ${runningLabel} | Runners: ${currentCount}/${config.maxRunners} (desired: ${desired})`
        );
      }

      const runnersTtl = Math.max(120, config.pollIntervalSecs * 4);
      await redis.set(RUNNERS_KEY, JSON.stringify(runners), 'EX', runnersTtl);
      return true;
    });

    const isNowLeader = r.acquired;
    if (wasLeader === undefined) {
      console.log(`[Scaler] ${isNowLeader ? 'became leader' : 'joining as follower'}`);
    } else if (isNowLeader && !wasLeader) {
      console.log('[Scaler] became leader');
    } else if (!isNowLeader && wasLeader) {
      console.log('[Scaler] lost leadership');
    }
    wasLeader = isNowLeader;
  } catch (err) {
    console.error('[Scaler] Error in scaling loop:', (err as Error).message);
    // On error, force a re-edge by clearing wasLeader. Without this, an
    // error during the lock attempt or work() leaves wasLeader stale, and
    // the next successful tick could miss a became-leader / lost-leadership
    // log line.
    wasLeader = undefined;
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
    // Memory-aware demand: OS-VISIBLE RAM per VM (what os.totalmem()
    // reports on the droplet — 3912 on s-2vcpu-4gb, NOT the marketing
    // 4096) and the per-VM reserve for OS + dockerd + runner. Both must
    // match the runner side (os.totalmem / RUNNER_MEMORY_RESERVE_MB), or
    // the scaler sizes a pool the runners' claim gates won't fill and
    // READY runs sit unclaimed. Re-pin SCALER_RUNNER_MEMORY_MB whenever
    // SCALER_RUNNER_SIZE changes.
    runnerMemoryMb: Math.max(512, intEnv('SCALER_RUNNER_MEMORY_MB', 3912)),
    memoryReserveMb: Math.max(0, intEnv('SCALER_MEMORY_RESERVE_MB', 768)),
    maxReadyWaitSecs: Math.max(0, intEnv('SCALER_MAX_READY_WAIT_SECS', 300)),
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
