/**
 * Configuration with security-first defaults.
 *
 * SECURITY: In production, all sensitive values MUST be provided via environment variables.
 * Development defaults are only used when NODE_ENV !== 'production'.
 */

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

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
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
};
