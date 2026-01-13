import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to get fresh config
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use default values when environment variables are not set', async () => {
    // Import fresh config module
    const { config } = await import('../src/config.js');

    expect(config.apiBaseUrl).toBe('http://localhost:3000');
    expect(config.apiToken).toBe('runner-token');
    expect(config.databaseUrl).toBe('postgresql://postgres:postgres@localhost:5432/crawlee_cloud');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.dockerSocketPath).toBe('/var/run/docker.sock');
    expect(config.dockerNetwork).toBe('crawlee-cloud_default');
    expect(config.defaultMemoryMb).toBe(1024);
    expect(config.defaultTimeoutSecs).toBe(3600);
    expect(config.maxConcurrentRuns).toBe(10);
    expect(config.logLevel).toBe('info');
  });

  it('should use environment variables when set', async () => {
    process.env.API_BASE_URL = 'http://custom-api:8080';
    process.env.API_TOKEN = 'custom-token';
    process.env.DATABASE_URL = 'postgresql://user:pass@db:5432/custom';
    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.DOCKER_SOCKET = '/custom/docker.sock';
    process.env.DOCKER_NETWORK = 'custom-network';
    process.env.DEFAULT_MEMORY_MB = '2048';
    process.env.DEFAULT_TIMEOUT_SECS = '7200';
    process.env.MAX_CONCURRENT_RUNS = '20';
    process.env.LOG_LEVEL = 'debug';

    const { config } = await import('../src/config.js');

    expect(config.apiBaseUrl).toBe('http://custom-api:8080');
    expect(config.apiToken).toBe('custom-token');
    expect(config.databaseUrl).toBe('postgresql://user:pass@db:5432/custom');
    expect(config.redisUrl).toBe('redis://redis:6379');
    expect(config.dockerSocketPath).toBe('/custom/docker.sock');
    expect(config.dockerNetwork).toBe('custom-network');
    expect(config.defaultMemoryMb).toBe(2048);
    expect(config.defaultTimeoutSecs).toBe(7200);
    expect(config.maxConcurrentRuns).toBe(20);
    expect(config.logLevel).toBe('debug');
  });

  it('should parse integer environment variables correctly', async () => {
    process.env.DEFAULT_MEMORY_MB = '512';
    process.env.DEFAULT_TIMEOUT_SECS = '1800';
    process.env.MAX_CONCURRENT_RUNS = '5';

    const { config } = await import('../src/config.js');

    expect(config.defaultMemoryMb).toBe(512);
    expect(typeof config.defaultMemoryMb).toBe('number');
    expect(config.defaultTimeoutSecs).toBe(1800);
    expect(typeof config.defaultTimeoutSecs).toBe('number');
    expect(config.maxConcurrentRuns).toBe(5);
    expect(typeof config.maxConcurrentRuns).toBe('number');
  });

  it('should handle empty integer environment variables with defaults', async () => {
    process.env.DEFAULT_MEMORY_MB = '';

    const { config } = await import('../src/config.js');

    expect(config.defaultMemoryMb).toBe(1024); // Default value
  });
});
