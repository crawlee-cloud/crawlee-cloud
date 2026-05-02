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
    delete process.env.SCALER_RUNS_PER_RUNNER;
  });

  it('with scaler ON + local-docker provider, sources defaults from runner config fallbacks (1024/3600)', async () => {
    // Split deploy, local-docker provider. The provider only injects
    // MAX_CONCURRENT_RUNS — runners fall back to packages/runner/src/
    // config.ts defaults for memory/timeout (1024/3600). The API host's
    // own MAX_CONCURRENT_RUNS=15 is a deliberate distractor: it's set
    // here to verify it's IGNORED when scaler is on, since the API
    // doesn't run actors.
    process.env.MAX_CONCURRENT_RUNS = '15';
    process.env.SCALER_ENABLED = 'true';
    process.env.SCALER_PROVIDER = 'local-docker';
    process.env.SCALER_MIN_RUNNERS = '2';
    process.env.SCALER_MAX_RUNNERS = '8';
    process.env.SCALER_RUNS_PER_RUNNER = '3';

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      nodeVersion: process.version,
      executionDefaults: {
        maxConcurrentRuns: 3, // SCALER_RUNS_PER_RUNNER, NOT MAX_CONCURRENT_RUNS=15
        defaultMemoryMb: 1024, // local-docker → runner config fallback
        defaultTimeoutSecs: 3600,
      },
      scaler: { enabled: true, provider: 'local-docker', minRunners: 2, maxRunners: 8 },
    });
  });

  it('with scaler ON + digitalocean provider, sources defaults from cloud-init constants (2048/3600)', async () => {
    // DigitalOcean cloud-init explicitly bumps memory to 2048; the
    // dashboard must reflect that bump rather than the runner-config
    // fallback. Different value than the local-docker test above —
    // both providers have to be exercised because they don't share
    // defaults, which was the bug Codex caught on PR #20.
    process.env.SCALER_ENABLED = 'true';
    process.env.SCALER_PROVIDER = 'digitalocean';
    process.env.SCALER_RUNS_PER_RUNNER = '5';

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: {
        executionDefaults: {
          defaultMemoryMb: number;
          defaultTimeoutSecs: number;
          maxConcurrentRuns: number;
        };
      };
    };
    expect(body.data.executionDefaults).toEqual({
      maxConcurrentRuns: 5,
      defaultMemoryMb: 2048, // CLOUD_INIT_DEFAULT_MEMORY_MB — DO-specific bump
      defaultTimeoutSecs: 3600,
    });
  });

  it('with scaler ON + unknown provider, falls back to runner config defaults — wrong-but-honest', async () => {
    process.env.SCALER_ENABLED = 'true';
    process.env.SCALER_PROVIDER = 'some-future-provider';
    process.env.SCALER_RUNS_PER_RUNNER = '7';

    const response = await app.inject({ method: 'GET', url: '/v2/system/info' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: { executionDefaults: { defaultMemoryMb: number; defaultTimeoutSecs: number } };
    };
    // Confidently-misleading would be 2048 just because we know one provider
    // happens to use that. Falling back to the runner-config defaults is the
    // less-wrong choice when we have no provider-specific knowledge.
    expect(body.data.executionDefaults.defaultMemoryMb).toBe(1024);
    expect(body.data.executionDefaults.defaultTimeoutSecs).toBe(3600);
  });

  it('with scaler OFF, sources execution defaults from API-process env (single-host)', async () => {
    // Single-host: the API process *is* (or shares env with) the runner,
    // so MAX_CONCURRENT_RUNS / DEFAULT_MEMORY_MB / DEFAULT_TIMEOUT_SECS on
    // the API are authoritative.
    process.env.MAX_CONCURRENT_RUNS = '15';
    process.env.DEFAULT_MEMORY_MB = '4096';
    process.env.DEFAULT_TIMEOUT_SECS = '7200';
    // SCALER_ENABLED unset → loadScalerConfig() reports enabled: false

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
      maxConcurrentRuns: 15,
      defaultMemoryMb: 4096,
      defaultTimeoutSecs: 7200,
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
