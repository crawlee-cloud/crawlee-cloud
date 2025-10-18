export interface Config {
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3Region: string;
  s3ForcePathStyle: boolean;
  apiSecret: string;
}

function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing: ${key}`);
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
  logLevel: env('LOG_LEVEL', 'info'),
  databaseUrl: env('DATABASE_URL', 'postgresql://crawlee:password@localhost:5432/crawlee_cloud'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  s3Endpoint: env('S3_ENDPOINT', 'http://localhost:9000'),
  s3AccessKey: env('S3_ACCESS_KEY', 'minioadmin'),
  s3SecretKey: env('S3_SECRET_KEY', 'minioadmin'),
  s3Bucket: env('S3_BUCKET', 'crawlee-cloud'),
  s3Region: env('S3_REGION', 'us-east-1'),
  s3ForcePathStyle: envBool('S3_FORCE_PATH_STYLE', true),
  apiSecret: env('API_SECRET', 'dev-secret-change-in-production'),
};
