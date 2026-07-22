/**
 * Registry Routes Tests — actor versions and builds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { registryRoutes } from '../src/routes/registry.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockRedisRpush = vi.fn();
const mockRedisLrange = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    rpush: (...args: unknown[]) => mockRedisRpush(...args),
    lrange: (...args: unknown[]) => mockRedisLrange(...args),
  },
}));

const createVersionRow = (overrides = {}) => ({
  id: 'ver-1',
  actor_id: 'actor-1',
  version_number: '0.1',
  source_type: 'GIT_REPO',
  source_url: 'https://github.com/example/actor',
  dockerfile: null,
  build_tag: 'latest',
  env_vars: { FOO: 'bar' },
  is_deprecated: false,
  created_at: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

const createBuildRow = (overrides = {}) => ({
  id: 'build-1',
  actor_id: 'actor-1',
  version_id: 'ver-1',
  status: 'RUNNING',
  started_at: new Date('2026-07-01T00:00:00Z'),
  finished_at: null,
  image_name: 'crawlee-cloud/test-actor:build-1',
  image_digest: null,
  image_size_bytes: null,
  log_count: 0,
  git_branch: 'main',
  git_commit: 'abc1234',
  created_at: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

describe('Registry Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(registryRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRedisRpush.mockReset();
    mockRedisLrange.mockReset();
  });

  describe('GET /v2/acts/:actorId/versions', () => {
    it('lists versions in camelCase format', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createVersionRow()] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/versions' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.total).toBe(1);
      expect(body.data.items[0]).toMatchObject({
        id: 'ver-1',
        actorId: 'actor-1',
        versionNumber: '0.1',
        sourceType: 'GIT_REPO',
        buildTag: 'latest',
        envVars: { FOO: 'bar' },
        isDeprecated: false,
      });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('FROM actor_versions');
      expect(params).toEqual(['actor-1']);
    });
  });

  describe('POST /v2/acts/:actorId/versions', () => {
    it('creates a version with defaults and clears sibling build tags', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'actor-1' }] }) // actor exists
        .mockResolvedValueOnce({ rows: [createVersionRow()] }); // insert

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/versions',
        payload: { versionNumber: '0.1', buildTag: 'latest', envVars: { FOO: 'bar' } },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data.versionNumber).toBe('0.1');
      const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      // Sibling versions holding the same tag are cleared in the same statement.
      expect(sql).toContain('UPDATE actor_versions SET build_tag = NULL');
      expect(sql).toContain('INSERT INTO actor_versions');
      expect(params[2]).toBe('0.1');
      expect(params[3]).toBe('GIT_REPO'); // sourceType default
      expect(params[7]).toBe(JSON.stringify({ FOO: 'bar' }));
    });

    it('returns 404 when the actor does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/nope/versions',
        payload: { versionNumber: '0.1' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('stores null env vars when none are provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'actor-1' }] })
        .mockResolvedValueOnce({ rows: [createVersionRow({ env_vars: null })] });

      await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/versions',
        payload: { versionNumber: '0.2' },
      });

      const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(params[7]).toBeNull();
    });
  });

  describe('GET /v2/acts/:actorId/versions/:versionId', () => {
    it('returns the version scoped to the actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createVersionRow()] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/versions/ver-1' });

      expect(response.statusCode).toBe(200);
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['ver-1', 'actor-1']);
    });

    it('returns 404 for a missing version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/versions/nope' });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe('Version not found');
    });
  });

  describe('DELETE /v2/acts/:actorId/versions/:versionId', () => {
    it('deletes idempotently and returns 204', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/acts/actor-1/versions/ver-1',
      });

      expect(response.statusCode).toBe(204);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('DELETE FROM actor_versions');
      expect(params).toEqual(['ver-1', 'actor-1']);
    });
  });

  describe('GET /v2/acts/:actorId/builds', () => {
    it('lists builds with joined version info', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createBuildRow({ version_number: '0.1', build_tag: 'latest' })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/builds' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.total).toBe(1);
      expect(body.data.items[0]).toMatchObject({
        id: 'build-1',
        actorId: 'actor-1',
        versionNumber: '0.1',
        buildTag: 'latest',
        status: 'RUNNING',
        imageName: 'crawlee-cloud/test-actor:build-1',
      });
      const [sql] = mockQuery.mock.calls[0] as [string];
      expect(sql).toContain('LEFT JOIN actor_versions');
    });

    it('nulls the joined fields for builds whose version was deleted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createBuildRow({ version_id: null })] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/builds' });

      const item = response.json().data.items[0];
      expect(item.versionNumber).toBeNull();
      expect(item.buildTag).toBeNull();
    });
  });

  describe('POST /v2/acts/:actorId/builds', () => {
    it('creates a RUNNING build and queues the job in Redis', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'actor-1', name: 'test-actor' }] })
        .mockResolvedValueOnce({ rows: [createBuildRow()] });
      mockRedisRpush.mockResolvedValueOnce(1);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/builds',
        payload: { versionId: 'ver-1', gitBranch: 'main', gitCommit: 'abc1234' },
      });

      expect(response.statusCode).toBe(201);
      const [insertSql, insertParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(insertSql).toContain("'RUNNING'");
      // Image name derives from the actor name + build id prefix.
      expect(insertParams[3]).toMatch(/^crawlee-cloud\/test-actor:[A-Za-z0-9_-]{8}$/);

      expect(mockRedisRpush).toHaveBeenCalledTimes(1);
      const [queueKey, jobJson] = mockRedisRpush.mock.calls[0] as [string, string];
      expect(queueKey).toBe('build_queue');
      const job = JSON.parse(jobJson) as Record<string, unknown>;
      expect(job).toMatchObject({
        actorId: 'actor-1',
        versionId: 'ver-1',
        gitBranch: 'main',
        gitCommit: 'abc1234',
      });
      expect(job.buildId).toBeTruthy();
      expect(job.imageName).toBe(insertParams[3]);
    });

    it('returns 404 without queueing when the actor is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/nope/builds',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(mockRedisRpush).not.toHaveBeenCalled();
    });
  });

  describe('GET /v2/acts/:actorId/builds/:buildId', () => {
    it('returns the build scoped to the actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createBuildRow()] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/builds/build-1' });

      expect(response.statusCode).toBe(200);
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['build-1', 'actor-1']);
    });

    it('returns 404 for a missing build', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/builds/nope' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /v2/acts/:actorId/builds/:buildId/abort', () => {
    it('aborts a RUNNING build', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createBuildRow({ status: 'ABORTED', finished_at: new Date() })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/builds/build-1/abort',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('ABORTED');
      const [sql] = mockQuery.mock.calls[0] as [string];
      // Only RUNNING builds are abortable — the guard lives in the WHERE.
      expect(sql).toContain("status = 'RUNNING'");
      expect(sql).toContain("SET status = 'ABORTED'");
    });

    it('returns 404 when the build is not running (or missing)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/builds/build-1/abort',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe('Build not found or not running');
    });
  });

  describe('GET /v2/acts/:actorId/builds/:buildId/logs', () => {
    it('reads the requested log window from Redis', async () => {
      mockRedisLrange.mockResolvedValueOnce([
        JSON.stringify({ line: 'step 1' }),
        JSON.stringify({ line: 'step 2' }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/actor-1/builds/build-1/logs?offset=10&limit=2',
      });

      expect(response.statusCode).toBe(200);
      expect(mockRedisLrange).toHaveBeenCalledWith('build_logs:build-1', 10, 11);
      const body = response.json();
      expect(body.data).toMatchObject({ offset: 10, limit: 2, count: 2 });
      expect(body.data.items[1].line).toBe('step 2');
    });

    it('defaults to offset 0 and limit 100', async () => {
      mockRedisLrange.mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/actor-1/builds/build-1/logs',
      });

      expect(mockRedisLrange).toHaveBeenCalledWith('build_logs:build-1', 0, 99);
      expect(response.json().data.count).toBe(0);
    });
  });
});
