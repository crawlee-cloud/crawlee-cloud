/**
 * Configuration with security-first defaults.
 *
 * SECURITY: In production, all sensitive values MUST be provided via environment variables.
 * Development defaults are only used when NODE_ENV !== 'production'.
 */
import cron from 'node-cron';

export interface Config {
  port: number;
  logLevel: string;
  nodeEnv: string;
  databaseUrl: string;
  redisUrl: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3Region: string;
  s3ForcePathStyle: boolean;
  apiSecret: string;
  corsOrigins: string;
  adminEmail?: string;
  adminPassword?: string;

  // SECURITY: opt-in escape hatch for self-hosted operators on private
  // networks. Defaults to false (admin-only). When true, GET /metrics is
  // unauthenticated — only safe behind a private network / VPN. There is
  // intentionally no equivalent flag for /v2/scaler/status (runner IPs).
  metricsPublic: boolean;

  // PG pool ceiling. Default 8 fits DO Managed PG 1GB plan (22-conn ceiling)
  // with headroom for migrations and admin sessions. Bump on larger plans;
  // set high (50+) if a PgBouncer/pooler endpoint is in front of PG.
  dbPoolMax: number;

  // Items per S3 object on dataset push. Default 500. Lower if memory
  // pressure during downloads is a concern; raise (1000–2000) on Spaces/AWS
  // to further reduce PUT cost.
  datasetBatchSize: number;

  // Retention slice #3:
  retentionEnabled: boolean;
  retentionDays: number;
  retentionTombstoneDays: number;
  retentionBatchSize: number;
  retentionCron: string;
}

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Get required environment variable with optional development default.
 * In production, throws if the variable is not set.
 */
function env(key: string, devDefault?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;

  // Only use defaults in development
  if (isDevelopment && devDefault !== undefined) return devDefault;

  throw new Error(`Missing required environment variable: ${key}`);
}

function envOptional(key: string): string | undefined {
  return process.env[key];
}

function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

/**
 * Like envInt, but rejects values < min at startup with a clear message.
 * Use for config that would put the app into an unrecoverable state if
 * misconfigured — e.g. a negative DATASET_BATCH_SIZE makes the dataset
 * push loop step backward and never terminate (hangs the handler), and
 * a non-positive DB_POOL_MAX leaves pg-pool unable to allocate a single
 * connection (every query rejects).
 */
function envIntPositive(key: string, defaultValue: number, min = 1): number {
  const v = envInt(key, defaultValue);
  if (!Number.isFinite(v) || v < min) {
    throw new Error(
      `Invalid ${key}=${process.env[key] ?? '(unset)'} — must be an integer >= ${min}`
    );
  }
  return v;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

function envCron(key: string, defaultValue: string): string {
  const v = process.env[key] ?? defaultValue;
  if (!cron.validate(v)) {
    throw new Error(`Invalid ${key}=${v} — must be a valid cron expression`);
  }
  return v;
}

export const config: Config = {
  port: envInt('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  nodeEnv: env('NODE_ENV', 'development'),

  // Database - no default password in production
  databaseUrl: env('DATABASE_URL', 'postgresql://crawlee:devpassword@localhost:5432/crawlee_cloud'),

  // Redis
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),

  // S3/MinIO - no default credentials in production
  s3Endpoint: env('S3_ENDPOINT', 'http://localhost:9000'),
  s3AccessKey: env('S3_ACCESS_KEY', 'minioadmin'),
  s3SecretKey: env('S3_SECRET_KEY', 'minioadmin'),
  s3Bucket: env('S3_BUCKET', 'crawlee-cloud'),
  s3Region: env('S3_REGION', 'us-east-1'),
  s3ForcePathStyle: envBool('S3_FORCE_PATH_STYLE', true),

  // API Secret - MUST be set in production, min 32 chars recommended
  apiSecret: env('API_SECRET', 'dev-secret-do-not-use-in-production-32chars'),

  // CORS - MUST be configured in production (comma-separated origins)
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001'),

  // Admin user (optional)
  adminEmail: envOptional('ADMIN_EMAIL'),
  adminPassword: envOptional('ADMIN_PASSWORD'),

  metricsPublic: envBool('METRICS_PUBLIC', false),

  // Both must be >= 1: a non-positive DB_POOL_MAX leaves pg-pool unable
  // to allocate connections; a non-positive DATASET_BATCH_SIZE makes the
  // push loop step backward and never terminate.
  dbPoolMax: envIntPositive('DB_POOL_MAX', 8),
  datasetBatchSize: envIntPositive('DATASET_BATCH_SIZE', 500),

  retentionEnabled: envBool('RETENTION_ENABLED', true),
  retentionDays: envIntPositive('RETENTION_DAYS', 30),
  retentionTombstoneDays: envIntPositive('RETENTION_TOMBSTONE_DAYS', 365),
  retentionBatchSize: envIntPositive('RETENTION_BATCH_SIZE', 500),
  retentionCron: envCron('RETENTION_CRON', '0 3 * * *'),
};
