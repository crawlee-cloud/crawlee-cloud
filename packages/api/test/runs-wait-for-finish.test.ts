/**
 * GET /v2/actor-runs/:runId?waitForFinish=N — long-poll route tests.
 *
 * Timing behaviour is tested via inject() with fake timers; client disconnect
 * and server shutdown need a real socket (inject() has no connection to
 * close), so those use app.listen() + fetch with real timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn(),
}));
vi.mock('../src/storage/s3.js', () => ({}));
vi.mock('../src/storage/redis.js', () => ({ redis: {} }));
vi.mock('../src/config.js', () => ({ config: { apifyCuPrice: 0.4 } }));

import { runsRoutes } from '../src/routes/runs.js';

const runRow = (status: string) => ({
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'test-user-id',
  status,
  status_message: null,
  started_at: new Date(),
  finished_at: status === 'RUNNING' ? null : new Date(),
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'queue-1',
  timeout_secs: 3600,
  memory_mbytes: 1024,
  container_url: null,
  created_at: new Date(),
  modified_at: new Date(),
  default_dataset_item_count: 0,
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Mirror production's ZodError → 400 handler (src/index.ts).
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { type: 'validation_error' } });
    }
    return reply.send(error);
  });
  await app.register(runsRoutes, { prefix: '/v2' });
  await app.ready();
  return app;
}

function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void p.then((v) => {
    state.settled = true;
    state.value = v;
  });
  return state;
}

describe('GET /v2/actor-runs/:runId?waitForFinish (fake timers)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQuery.mockReset();
    app = await buildApp();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app.close();
  });

  it('returns immediately with a single query when waitForFinish is absent', async () => {
    mockQuery.mockResolvedValue({ rows: [runRow('RUNNING')] });
    const res = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('RUNNING');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns immediately with a single query when waitForFinish=0', async () => {
    mockQuery.mockResolvedValue({ rows: [runRow('RUNNING')] });
    const res = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1?waitForFinish=0' });
    expect(res.json().data.status).toBe('RUNNING');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('responds as soon as the run becomes terminal (finishes after ~3s, waitForFinish=20)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [runRow('RUNNING')] })
      .mockResolvedValueOnce({ rows: [runRow('RUNNING')] })
      .mockResolvedValueOnce({ rows: [runRow('RUNNING')] })
      .mockResolvedValue({ rows: [runRow('SUCCEEDED')] });

    const probe = track(
      app.inject({ method: 'GET', url: '/v2/actor-runs/run-1?waitForFinish=20' })
    );
    await vi.advanceTimersByTimeAsync(2_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
    expect(probe.value.statusCode).toBe(200);
    expect(probe.value.json().data.status).toBe('SUCCEEDED');
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it('responds with the non-terminal state after waitForFinish seconds', async () => {
    mockQuery.mockResolvedValue({ rows: [runRow('RUNNING')] });

    const probe = track(app.inject({ method: 'GET', url: '/v2/actor-runs/run-1?waitForFinish=5' }));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
    expect(probe.value.json().data.status).toBe('RUNNING');
  });

  it('clamps waitForFinish=600 to 60s', async () => {
    mockQuery.mockResolvedValue({ rows: [runRow('RUNNING')] });

    const probe = track(
      app.inject({ method: 'GET', url: '/v2/actor-runs/run-1?waitForFinish=600' })
    );
    await vi.advanceTimersByTimeAsync(59_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
    expect(probe.value.json().data.status).toBe('RUNNING');
  });

  it('returns 404 immediately for an unknown run', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await app.inject({ method: 'GET', url: '/v2/actor-runs/nope?waitForFinish=20' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('record-not-found');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', 'abc', '2.5'])('rejects waitForFinish=%s with 400 validation_error', async (v) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs/run-1?waitForFinish=${v}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('validation_error');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('GET /v2/actor-runs/:runId?waitForFinish (real socket)', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [runRow('RUNNING')] });
    app = await buildApp();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('keeps waiting while the client stays connected (request close does not end the wait)', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/v2/actor-runs/run-1?waitForFinish=2`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('RUNNING');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('stops polling when the client disconnects', async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/v2/actor-runs/run-1?waitForFinish=60`, {
      signal: controller.signal,
    }).catch((err: unknown) => err);

    await sleep(1_300);
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);

    await sleep(100);
    const callsAfterAbort = mockQuery.mock.calls.length;
    await sleep(2_200);
    expect(mockQuery.mock.calls.length).toBe(callsAfterAbort);
  }, 15_000);

  it('ends pending waits with a normal response when the server shuts down', async () => {
    const started = Date.now();
    const pending = fetch(`${baseUrl}/v2/actor-runs/run-1?waitForFinish=60`);

    await sleep(300);
    const closeStarted = Date.now();
    const closing = app.close();

    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('RUNNING');
    await closing;
    expect(Date.now() - closeStarted).toBeLessThan(1_500);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);
});
