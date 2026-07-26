/**
 * Runner configuration from environment variables.
 */

import os from 'node:os';

export interface Config {
  // API connection
  apiBaseUrl: string;
  apiToken: string;

  // Database
  databaseUrl: string;

  // Redis for job queue
  redisUrl: string;

  // Docker
  dockerSocketPath: string;
  dockerNetwork: string;

  // Image registry (e.g. ghcr.io/org/repo)
  // When set, runner pulls images from registry instead of expecting local builds
  imageRegistry: string;
  imageRegistryUser: string;
  imageRegistryToken: string;

  // Container defaults
  defaultMemoryMb: number;
  defaultTimeoutSecs: number;
  maxConcurrentRuns: number;

  // Host-memory admission control. The sum of active containers' memory
  // LIMITS must never exceed host RAM minus this reserve (OS + dockerd +
  // this runner process): limits the kernel can't honor turn coincident
  // memory peaks into host-level OOM — which sometimes kills the actor
  // container (clean FAILED) and sometimes wedges the whole droplet
  // (2026-07-16: two droplets pinned at 0MB available, heartbeat death,
  // 3 zombie runs). See claimNextRun (queue.ts) and clampMemoryToHost
  // (docker.ts).
  hostTotalMemoryMb: number;
  memoryReserveMb: number;
  // How long an unfittable READY run may wait (from eligibility) before
  // busy hosts stop claiming past it and drain toward idle — the claim-
  // side half of starvation protection; the scaler's
  // SCALER_MAX_READY_WAIT_SECS escalation is the capacity-side half.
  starvedReadyWaitSecs: number;

  // Apify proxy defaults — injected into actor containers as the
  // platform-level fallback. Per-actor and per-user overrides resolved
  // in queue.ts → proxy-resolver.ts take precedence over these.
  apifyProxyPassword: string;
  apifyProxyHostname: string; // '' → SDK default (proxy.apify.com)
  apifyProxyPort: number; // 0  → SDK default (8000)

  // Cost attribution — stamped onto runs at claim time (queue.ts), see
  // docs/superpowers/specs/2026-07-15-run-cost-analysis-design.md.
  // runnerId doubles as the heartbeat identity: on DO, cloud-init pins
  // RUNNER_ID to the droplet id; the hostname fallback (= droplet name)
  // is also unique per droplet, so overlap grouping is safe either way.
  runnerId: string;
  runnerPriceHourly: number | null; // null → "not recorded" in cost views
  runnerProvider: string; // 'digitalocean' via cloud-init; local default

  // Logging
  logLevel: string;
}

function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required environment variable: ${key}`);
}

// Number() (not parseInt): "4GB" must not silently become 4 — a garbage
// HOST_TOTAL_MEMORY_MB would otherwise produce NaN/nonsense headroom in
// the claim SQL (errors every poll tick) and a wrong container limit.
// Invalid values fall back to the default with a warning.
function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[Runner] Ignoring invalid ${key}="${value}" — using default ${String(defaultValue)}`
    );
    return defaultValue;
  }
  return parsed;
}

// Null (not 0) for unset/garbage: the cost endpoint treats NULL as "price
// not recorded" while 0 would read as "this droplet is free" and produce a
// confidently wrong $0.00 cost.
function envFloatOrNull(key: string): number | null {
  const value = process.env[key];
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export const config: Config = {
  apiBaseUrl: env('API_BASE_URL', 'http://localhost:3000'),
  apiToken: env('API_TOKEN', 'runner-token'),

  databaseUrl: env('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/crawlee_cloud'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),

  dockerSocketPath: env('DOCKER_SOCKET', '/var/run/docker.sock'),
  dockerNetwork: env('DOCKER_NETWORK', 'crawlee-cloud_default'),

  imageRegistry: env('IMAGE_REGISTRY', ''),
  imageRegistryUser: env('IMAGE_REGISTRY_USER', ''),
  imageRegistryToken: env('IMAGE_REGISTRY_TOKEN', ''),

  defaultMemoryMb: envInt('DEFAULT_MEMORY_MB', 1024),
  defaultTimeoutSecs: envInt('DEFAULT_TIMEOUT_SECS', 3600),
  maxConcurrentRuns: envInt('MAX_CONCURRENT_RUNS', 10),

  // os.totalmem() is the physical host RAM in both boot modes: the
  // git-clone runner runs directly on the droplet, and the prebuilt-image
  // runner container has no memory limit of its own. Overridable for
  // exotic setups where the runner's view of RAM isn't the actors' host.
  hostTotalMemoryMb: envInt('HOST_TOTAL_MEMORY_MB', Math.round(os.totalmem() / (1024 * 1024))),
  memoryReserveMb: envInt('RUNNER_MEMORY_RESERVE_MB', 768),
  starvedReadyWaitSecs: envInt('RUNNER_MAX_READY_WAIT_SECS', 300),

  apifyProxyPassword: env('APIFY_PROXY_PASSWORD', ''),
  apifyProxyHostname: env('APIFY_PROXY_HOSTNAME', ''),
  apifyProxyPort: envInt('APIFY_PROXY_PORT', 0),

  // Truthiness (not env()'s set-vs-unset default): cloud-init derives
  // RUNNER_ID from the DO metadata service, and a set-but-EMPTY value must
  // still fall back to the hostname — heartbeating as '' would desync
  // heartbeat identity from run stamping and break overlap grouping.
  runnerId: (process.env.RUNNER_ID ?? '').trim() || os.hostname(),
  runnerPriceHourly: envFloatOrNull('RUNNER_PRICE_HOURLY'),
  runnerProvider: env('RUNNER_PROVIDER', 'local-docker'),

  logLevel: env('LOG_LEVEL', 'info'),
};

// Proxy encryption key validation. PROXY_ENCRYPTION_KEY must match the value
// used by the API process — both encrypt/decrypt the same DB columns. If the
// API encrypts under K1 and the runner decrypts under K2, every decrypt fails,
// safeDecrypt() swallows it silently, and every actor run launches without
// the resolved proxy. Fail loud in production; warn in dev.
//
// Note: proxy-crypto.ts reads process.env.PROXY_ENCRYPTION_KEY directly, so
// this is a startup validation — not a config field threaded through callers.
{
  const key = process.env.PROXY_ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !key) {
    process.stderr.write(
      '[Runner] FATAL: PROXY_ENCRYPTION_KEY is not set in production.\n' +
        '  Without it, proxy-crypto falls back to sha256(API_SECRET) — which\n' +
        '  must then be identical on the API and runner. If it is not, every\n' +
        '  decrypt fails silently and runs proceed without their resolved\n' +
        '  proxy credentials. Set PROXY_ENCRYPTION_KEY (64 hex chars) on both\n' +
        '  processes. Generate one with:\n' +
        "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n"
    );
    process.exit(1);
  }
  // Hex regex catches both wrong length AND non-hex chars in one check.
  // Buffer.from(s, 'hex') silently truncates at the first non-hex character,
  // so a 64-char garbage string would otherwise pass a naive .length === 64
  // check and break at runtime when the AES key buffer comes back < 32 bytes.
  if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
    process.stderr.write(
      '[Runner] FATAL: PROXY_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).\n'
    );
    process.exit(1);
  }
}
