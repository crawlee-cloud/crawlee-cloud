/**
 * Runner configuration from environment variables.
 */

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

  // Apify proxy defaults — injected into actor containers as the
  // platform-level fallback. Per-actor and per-user overrides resolved
  // in queue.ts → proxy-resolver.ts take precedence over these.
  apifyProxyPassword: string;
  apifyProxyHostname: string; // '' → SDK default (proxy.apify.com)
  apifyProxyPort: number; // 0  → SDK default (8000)

  // Logging
  logLevel: string;
}

function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
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

  apifyProxyPassword: env('APIFY_PROXY_PASSWORD', ''),
  apifyProxyHostname: env('APIFY_PROXY_HOSTNAME', ''),
  apifyProxyPort: envInt('APIFY_PROXY_PORT', 0),

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
