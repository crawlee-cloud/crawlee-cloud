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
  
  // Container defaults
  defaultMemoryMb: number;
  defaultTimeoutSecs: number;
  maxConcurrentRuns: number;
  
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
  
  defaultMemoryMb: envInt('DEFAULT_MEMORY_MB', 1024),
  defaultTimeoutSecs: envInt('DEFAULT_TIMEOUT_SECS', 3600),
  maxConcurrentRuns: envInt('MAX_CONCURRENT_RUNS', 10),
  
  logLevel: env('LOG_LEVEL', 'info'),
};
