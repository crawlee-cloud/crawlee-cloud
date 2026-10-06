/**
 * POST /v2/acts/:actorId/runs body contract (#115): Apify body + query
 * options vs. the legacy wrapper body, content-type gate, run-sync
 * forwarding and waitForFinish on start.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { ZodError } from 'zod';

const authHeaders: Array<string | undefined> = [];
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: {
    headers: Record<string, string | undefined>;
    user?: { id: string; email: string; role: string };
  }) => {
    authHeaders.push(request.headers.authorization);
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn(),
}));

const mockRedisPublish = vi.fn();
const mockRedisSet = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: (...args: unknown[]) => mockRedisPublish(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  },
}));

const mockPutKVRecord = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: (...args: unknown[]) => mockPutKVRecord(...args),
}));

import { actorsRoutes } from '../src/routes/actors.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'test-user-id',
  status: 'READY',
  started_at: null,
  finished_at: null,
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'rq-1',
  timeout_secs: 3600,
  memory_mbytes: 1024,
  created_at: new Date(),
  modified_at: new Date(),
  default_dataset_item_count: 0,
  ...overrides,
});

/** Queues the query results of one successful run start (no webhooks). */
function mockRunStart(defaultRunOptions: Record<string, unknown> | null = null) {
  mockQuery
    .mockResolvedValueOnce({
      rows: [{ id: 'actor-1', name: 'demo', default_run_options: defaultRunOptions }],
    }) // actor lookup
    .mockResolvedValueOnce({ rows: [] }) // dataset
    .mockResolvedValueOnce({ rows: [] }) // kv store
    .mockResolvedValueOnce({ rows: [] }) // request queue
    .mockResolvedValueOnce({ rows: [] }) // build lookup
    .mockResolvedValueOnce({ rows: [runRow()] }); // run INSERT
}

function runInsertParams(): unknown[] {
  const call = mockQuery.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO runs')
  );
  if (!call) throw new Error('run INSERT not made');
  return call[1] as unknown[];
}

function storedInput(): unknown {
  const call = mockPutKVRecord.mock.calls.find((c) => c[1] === 'INPUT');
  if (!call) throw new Error('INPUT record not written');
  return JSON.parse(call[2] as string);
}

describe('POST /v2/acts/:actorId/runs body contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // Same global parsers as src/index.ts, so text/plain and octet-stream
    // reach the handler as Buffers (as in production).
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body || {})
    );
    app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body)
    );
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body)
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.setErrorHandler((error: any, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: { type: 'validation_error' } });
      }
      reply.status(500).send({ error: { message: error.message } });
    });
    app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'acts' });
    app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'actors' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRedisPublish.mockReset().mockResolvedValue(1);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockPutKVRecord.mockReset().mockResolvedValue(undefined);
    authHeaders.length = 0;
  });

  it('Apify body is the input; timeout/memory come from the query', async () => {
    mockRunStart({ timeoutSecs: 7200, memoryMbytes: 4096 });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs?timeout=60&memory=512',
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({ query: 'x' });
    const params = runInsertParams();
    expect(params).toContain(60);
    expect(params).toContain(512);
    expect(params).not.toContain(7200);
  });

  it('works the same under the /v2/actors alias', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/actors/actor-1/runs?memory=512',
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({ query: 'x' });
    expect(runInsertParams()).toContain(512);
  });

  it('Apify input keys named like options are input, not options', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs',
      payload: { query: 'x', timeout: 'soon', envVars: { SECRET: 'no' } },
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({ query: 'x', timeout: 'soon', envVars: { SECRET: 'no' } });
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(runInsertParams()).toContain(3600);
  });

  it('?envVars=<base64> sets the run env vars', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: `/v2/acts/actor-1/runs?envVars=${encodeURIComponent(b64({ K: 'v' }))}`,
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(201);
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^run:.+:envVars$/),
      JSON.stringify({ K: 'v' }),
      'EX',
      86400
    );
  });

  it('?webhooks=<base64> persists per-run webhooks', async () => {
    mockRunStart();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // webhook INSERT
    const webhooks = [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: 'https://e.com/h' }];

    const response = await app.inject({
      method: 'POST',
      url: `/v2/acts/actor-1/runs?webhooks=${encodeURIComponent(b64(webhooks))}`,
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(201);
    const call = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO webhooks')
    );
    expect(call?.[1]).toContain('https://e.com/h');
  });

  it('dashboard body {timeout, memory} applies them and starts with input {}', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs',
      payload: { timeout: 1800, memory: 2048 },
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({});
    const params = runInsertParams();
    expect(params).toContain(1800);
    expect(params).toContain(2048);
  });

  it('legacy wrapper body keeps working, including envVars', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs?timeout=99',
      payload: { input: { url: 'https://e.com' }, timeout: 120, envVars: { K: 'v' } },
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({ url: 'https://e.com' });
    expect(runInsertParams()).toContain(120);
    expect(runInsertParams()).not.toContain(99);
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^run:.+:envVars$/),
      JSON.stringify({ K: 'v' }),
      'EX',
      86400
    );
  });

  it('no body starts with input {}', async () => {
    mockRunStart();

    const response = await app.inject({ method: 'POST', url: '/v2/acts/actor-1/runs' });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({});
  });

  it('empty form-urlencoded body (apify-client start() without input) starts with {}', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs?memory=512',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual({});
    expect(runInsertParams()).toContain(512);
  });

  it('non-object JSON input is stored as given', async () => {
    mockRunStart();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs',
      headers: { 'content-type': 'application/json' },
      payload: '["a","b"]',
    });

    expect(response.statusCode).toBe(201);
    expect(storedInput()).toEqual(['a', 'b']);
  });

  it.each(['text/plain', 'application/octet-stream'])(
    'rejects %s with 415 and starts nothing',
    async (contentType) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        headers: { 'content-type': contentType },
        payload: 'hello',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error.type).toBe('unsupported-media-type');
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockPutKVRecord).not.toHaveBeenCalled();
    }
  );

  it('rejects an invalid query option with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs?memory=lots',
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('?waitForFinish returns the full run once it is terminal', async () => {
    mockRunStart();
    mockQuery.mockResolvedValueOnce({ rows: [runRow({ status: 'SUCCEEDED' })] }); // loadRun

    const response = await app.inject({
      method: 'POST',
      url: '/v2/acts/actor-1/runs?waitForFinish=30',
      payload: { query: 'x' },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(data.status).toBe('SUCCEEDED');
    expect(data.options).toEqual({ timeoutSecs: 3600, memoryMbytes: 1024 });
    const loadCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(loadCall[0]).toContain('WHERE r.id = $1 AND r.user_id = $2');
  });

  describe('POST /v2/acts/:actorId/run-sync', () => {
    it('forwards the body, query string, Authorization and content type', async () => {
      mockRunStart();

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/run-sync?memory=512',
        headers: { authorization: 'Bearer tok-1' },
        payload: { query: 'x' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data.id).toBe('run-1');
      expect(storedInput()).toEqual({ query: 'x' });
      expect(runInsertParams()).toContain(512);
      // Outer request + forwarded request both carried the header.
      expect(authHeaders).toEqual(['Bearer tok-1', 'Bearer tok-1']);
    });

    it('URL-encodes the actor param', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // actor lookup → 404

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actors/user~my%3Factor/run-sync',
        payload: { query: 'x' },
      });

      expect(response.statusCode).toBe(404);
      expect(mockQuery.mock.calls[0][1]).toEqual(['user~my?actor', 'test-user-id']);
    });

    it('re-serializes non-object JSON input', async () => {
      mockRunStart();

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/run-sync',
        headers: { 'content-type': 'application/json' },
        payload: '"just a string"',
      });

      expect(response.statusCode).toBe(201);
      expect(storedInput()).toBe('just a string');
    });

    it('passes the 415 for text/plain through', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/run-sync',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(response.statusCode).toBe(415);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
