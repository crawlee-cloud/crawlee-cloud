/**
 * GET /v2/system/info — aggregate the dashboard Settings page consumes.
 * Locks the wire format so the page doesn't silently break when the route
 * shape changes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const TEST_USER = { id: 'test-user-id', email: 'test@example.com', role: 'admin' };

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { ...TEST_USER };
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) as unknown },
}));

const mockPing = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: { ping: () => mockPing() as unknown },
}));

const mockSend = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  s3: { send: (...args: unknown[]) => mockSend(...args) as unknown },
}));

vi.mock('../src/config.js', () => ({
  config: { s3Bucket: 'test-bucket' },
}));

vi.mock('../src/scheduler.js', () => ({
  getActiveScheduleCount: () => 0,
}));

import { systemRoutes } from '../src/routes/system.js';

describe('GET /v2/system/info', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(systemRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockPing.mockResolvedValue('PONG');
    mockSend.mockResolvedValue({});
    // Sane defaults; per-test overrides reset these between cases.
    delete process.env.MAX_CONCURRENT_RUNS;
    delete process.env.DEFAULT_MEMORY_MB;
    delete process.env.DEFAULT_TIMEOUT_SECS;
    delete process.env.SCALER_ENABLED;
    delete process.env.SCALER_PROVIDER;
    delete process.env.SCALER_MIN_RUNNERS;
    delete process.env.SCALER_MAX_RUNNERS;
  });

  it('returns version, node, storage health, execution defaults, and scaler state', async () => {
    process.env.MAX_CONCURRENT_RUNS = '15';
    process.env.DEFAULT_MEMORY_MB = '2048';
    process.env.SCALER_ENABLED = 'true';
    process.env.SCALER_PROVIDER = 'local-docker';
    process.env.SCALER_MIN_RUNNERS = '2';
    process.env.SCALER_MAX_RUNNERS = '8';

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      nodeVersion: process.version, // proves we're reading the live runtime version
      storage: {
        db: { status: 'ok' },
        redis: { status: 'ok' },
        s3: { status: 'ok' },
      },
      executionDefaults: {
        maxConcurrentRuns: 15,
        defaultMemoryMb: 2048,
        defaultTimeoutSecs: 3600, // default — env var not set in this case
      },
      scaler: {
        enabled: true,
        provider: 'local-docker',
        minRunners: 2,
        maxRunners: 8,
      },
    });
  });

  it('falls back to defaults when execution-default env vars are unset', async () => {
    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: {
        executionDefaults: {
          maxConcurrentRuns: number;
          defaultMemoryMb: number;
          defaultTimeoutSecs: number;
        };
      };
    };
    expect(body.data.executionDefaults).toEqual({
      maxConcurrentRuns: 10,
      defaultMemoryMb: 1024,
      defaultTimeoutSecs: 3600,
    });
  });

  it('treats non-finite integer env vars as missing rather than producing NaN', async () => {
    // Same NaN-guard contract as loadScalerConfig; lock it for the dashboard
    // surface too — a stray DEFAULT_MEMORY_MB=abc shouldn't ship "NaN MB" to
    // the Settings page.
    process.env.MAX_CONCURRENT_RUNS = 'abc';
    process.env.DEFAULT_MEMORY_MB = '';

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: { executionDefaults: { maxConcurrentRuns: number; defaultMemoryMb: number } };
    };
    expect(body.data.executionDefaults.maxConcurrentRuns).toBe(10);
    expect(body.data.executionDefaults.defaultMemoryMb).toBe(1024);
  });

  it('reports a storage backend as down when its probe fails', async () => {
    mockPing.mockRejectedValue(new Error('connection refused'));

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    // Endpoint still 200s — the dashboard wants to render partial data even
    // when one backend is sick, not refuse to load.
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: { storage: { redis: { status: string; error?: string } } };
    };
    expect(body.data.storage.redis.status).toBe('error');
    expect(body.data.storage.redis.error).toContain('connection refused');
  });
});
