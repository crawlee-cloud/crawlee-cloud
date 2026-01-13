import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../src/config.js', () => ({
  config: {
    apiBaseUrl: 'http://localhost:3000',
    apiToken: 'test-token',
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/crawlee_cloud',
    redisUrl: 'redis://localhost:6379',
    dockerSocketPath: '/var/run/docker.sock',
    dockerNetwork: 'test-network',
    defaultMemoryMb: 1024,
    defaultTimeoutSecs: 3600,
    maxConcurrentRuns: 10,
    logLevel: 'info',
  },
}));

describe('buildActorEnv', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  it('should build Apify-compatible environment variables', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      userId: 'user-789',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-api-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
      memoryMbytes: 2048,
      timeoutSecs: 1800,
    });

    expect(env.APIFY_ACTOR_ID).toBe('actor-456');
    expect(env.APIFY_ACTOR_RUN_ID).toBe('run-123');
    expect(env.APIFY_USER_ID).toBe('user-789');
    expect(env.APIFY_API_BASE_URL).toBe('http://api.example.com');
    expect(env.APIFY_TOKEN).toBe('test-api-token');
    expect(env.APIFY_API_PUBLIC_BASE_URL).toBe('http://api.example.com');
    expect(env.APIFY_DEFAULT_DATASET_ID).toBe('dataset-001');
    expect(env.APIFY_DEFAULT_KEY_VALUE_STORE_ID).toBe('kv-store-001');
    expect(env.APIFY_DEFAULT_REQUEST_QUEUE_ID).toBe('queue-001');
    expect(env.APIFY_IS_AT_HOME).toBe('1');
    expect(env.APIFY_HEADLESS).toBe('1');
    expect(env.APIFY_MEMORY_MBYTES).toBe('2048');
    expect(env.APIFY_INPUT_KEY).toBe('INPUT');
    expect(env.APIFY_CONTAINER_PORT).toBe('4321');
    expect(env.APIFY_CONTAINER_URL).toBe('http://run-run-123:4321');
    expect(env.CRAWLEE_STORAGE_DIR).toBe('/tmp/storage');
  });

  it('should calculate correct timeout timestamp', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
      timeoutSecs: 3600, // 1 hour
    });

    // Current time is 2024-01-15T10:00:00.000Z, timeout is 1 hour later
    expect(env.APIFY_TIMEOUT_AT).toBe('2024-01-15T11:00:00.000Z');
  });

  it('should use anonymous user ID when not provided', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
    });

    expect(env.APIFY_USER_ID).toBe('anonymous');
  });

  it('should use default memory and timeout from config when not provided', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
    });

    // Should use config defaults (1024MB memory, 3600s timeout)
    expect(env.APIFY_MEMORY_MBYTES).toBe('1024');
    expect(env.APIFY_TIMEOUT_AT).toBe('2024-01-15T11:00:00.000Z'); // 1 hour from 10:00
  });

  it('should include all required environment variables for Actor execution', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
    });

    // Check all required keys are present
    const requiredKeys = [
      'APIFY_ACTOR_ID',
      'APIFY_ACTOR_RUN_ID',
      'APIFY_USER_ID',
      'APIFY_API_BASE_URL',
      'APIFY_TOKEN',
      'APIFY_API_PUBLIC_BASE_URL',
      'APIFY_DEFAULT_DATASET_ID',
      'APIFY_DEFAULT_KEY_VALUE_STORE_ID',
      'APIFY_DEFAULT_REQUEST_QUEUE_ID',
      'APIFY_IS_AT_HOME',
      'APIFY_HEADLESS',
      'APIFY_MEMORY_MBYTES',
      'APIFY_TIMEOUT_AT',
      'APIFY_INPUT_KEY',
      'APIFY_CONTAINER_PORT',
      'APIFY_CONTAINER_URL',
      'CRAWLEE_STORAGE_DIR',
    ];

    for (const key of requiredKeys) {
      expect(env).toHaveProperty(key);
      expect(env[key]).toBeDefined();
      expect(env[key]).not.toBe('');
    }
  });

  it('should return string values for all environment variables', async () => {
    const { buildActorEnv } = await import('../src/docker.js');

    const env = buildActorEnv({
      runId: 'run-123',
      actorId: 'actor-456',
      apiBaseUrl: 'http://api.example.com',
      token: 'test-token',
      defaultDatasetId: 'dataset-001',
      defaultKeyValueStoreId: 'kv-store-001',
      defaultRequestQueueId: 'queue-001',
      memoryMbytes: 2048,
    });

    // All values should be strings (for Docker env compatibility)
    for (const [key, value] of Object.entries(env)) {
      expect(typeof value).toBe('string');
    }
  });
});
