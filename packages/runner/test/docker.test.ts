import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActorEnv, executeRun } from '../src/docker.js';

// Mock Dockerode
vi.mock('dockerode', () => {
  const DockerMock = vi.fn();
  DockerMock.prototype.createContainer = vi.fn();
  DockerMock.prototype.getImage = vi.fn();
  DockerMock.prototype.pull = vi.fn();
  return { default: DockerMock };
});

// Mock ioredis
vi.mock('ioredis', () => {
  const RedisMock = vi.fn();
  RedisMock.prototype.rpush = vi.fn();
  RedisMock.prototype.ltrim = vi.fn();
  RedisMock.prototype.expire = vi.fn();
  RedisMock.prototype.publish = vi.fn();
  return { Redis: RedisMock };
});

describe('docker.ts', () => {
  describe('buildActorEnv', () => {
    it('should build correct environment variables', () => {
      const options = {
        runId: 'run-123',
        actorId: 'actor-456',
        apiBaseUrl: 'http://localhost:3000',
        token: 'test-token',
        defaultDatasetId: 'dataset-1',
        defaultKeyValueStoreId: 'kvs-1',
        defaultRequestQueueId: 'queue-1',
        memoryMbytes: 1024,
        timeoutSecs: 60,
      };

      const env = buildActorEnv(options);

      expect(env).toMatchObject({
        APIFY_ACTOR_ID: 'actor-456',
        APIFY_ACTOR_RUN_ID: 'run-123',
        APIFY_API_BASE_URL: 'http://localhost:3000',
        APIFY_TOKEN: 'test-token',
        APIFY_DEFAULT_DATASET_ID: 'dataset-1',
        APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'kvs-1',
        APIFY_DEFAULT_REQUEST_QUEUE_ID: 'queue-1',
        APIFY_MEMORY_MBYTES: '1024',
        APIFY_CONTAINER_PORT: '4321',
      });

      expect(env.APIFY_TIMEOUT_AT).toBeDefined();
    });

    it('should use default values when optional parameters are missing', () => {
      const options = {
        runId: 'run-123',
        actorId: 'actor-456',
        apiBaseUrl: 'http://localhost:3000',
        token: 'test-token',
        defaultDatasetId: 'dataset-1',
        defaultKeyValueStoreId: 'kvs-1',
        defaultRequestQueueId: 'queue-1',
      };

      const env = buildActorEnv(options);

      expect(env.APIFY_MEMORY_MBYTES).toBeDefined();
      expect(env.APIFY_TIMEOUT_AT).toBeDefined();
    });
  });

  describe('executeRun', () => {
    let mockDocker: any;
    let mockContainer: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        // Setup Docker mock return values
        mockContainer = {
            id: 'container-123',
            attach: vi.fn().mockResolvedValue({
                on: vi.fn((event, cb) => {
                    if (event === 'end') setTimeout(cb, 10);
                    return this;
                }),
            }),
            start: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
            logs: vi.fn().mockResolvedValue('container logs'),
            remove: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
        };

        const Docker = (await import('dockerode')).default;
        // @ts-ignore
        mockDocker = Docker.mock.instances[0] || new Docker();

        // We need to ensure the mocked method returns our mock container
        // Since executeRun uses the global 'docker' instance created at module level,
        // which was created from our mock class.
        // We need to set the implementation on the prototype or the instance if we can access it.
        // But since we are mocking the class, all instances share the prototype methods if defined there?
        // Or we can manipulate the instance if we can find it.

        // Simplest way with vitest class mocks:
        // The mock returned by vi.mock factory is the class constructor.
        // Instances created from it are also mocks.
        // We need to make sure `createContainer` on any instance returns `mockContainer`.

        // @ts-ignore
        Docker.prototype.createContainer.mockResolvedValue(mockContainer);
        // @ts-ignore
        Docker.prototype.getImage.mockReturnValue({
            inspect: vi.fn().mockResolvedValue({}),
        });
    });

    it('should create and run a container', async () => {
       const options = {
        runId: 'run-123',
        actorId: 'actor-456',
        image: 'my-actor-image',
        env: { FOO: 'bar' },
      };

      const result = await executeRun(options);

      expect(result.exitCode).toBe(0);
      expect(result.logs).toBe('container logs');
    });
  });
});
