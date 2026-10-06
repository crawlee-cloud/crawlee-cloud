/**
 * Default build and build-by-ID routes (#117):
 *   GET /v2/acts/:actorId/builds/default (and /v2/actors/...)
 *   GET /v2/actor-builds/:buildId
 * plus the shared build helpers in src/lib/builds.ts.
 *
 * The default-build *choice* (latest tag, rollback, RUNNING orphans) is SQL
 * and is covered against Postgres in test/integration/actor-builds.int.test.ts;
 * here we check the query shape, scoping, response shape and waitForFinish.
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
const mockResolveActor = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (sql: string, params?: unknown[]) =>
    sql.includes('JOIN users u ON u.id = a.user_id')
      ? mockResolveActor(sql, params)
      : mockQuery(sql, params),
}));
vi.mock('../src/storage/redis.js', () => ({ redis: {} }));

import { registryRoutes, actorBuildsRoutes } from '../src/routes/registry.js';
import { formatBuild, selectDefaultBuilds } from '../src/lib/builds.js';

const OWN_ACTOR = { id: 'actor-1', name: 'x', user_id: 'test-user-id', username: 'alice' };

const definition = {
  actorSpecification: 1,
  name: 'x',
  version: '0.1',
  input: { title: 'Input', type: 'object', schemaVersion: 1, properties: {} },
};

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'build-1',
  actor_id: 'actor-1',
  version_id: 'ver-1',
  status: 'SUCCEEDED',
  started_at: new Date('2026-07-01T00:00:00Z'),
  finished_at: new Date('2026-07-01T00:00:00Z'),
  image_name: 'ghcr.io/alice/x:1',
  image_digest: null,
  image_size_bytes: null,
  log_count: 0,
  git_branch: null,
  git_commit: null,
  created_at: new Date('2026-07-01T00:00:00Z'),
  version_number: '0.1',
  build_tag: 'latest',
  user_id: 'test-user-id',
  build_number: '0.1.2',
  actor_definition: definition,
  ...overrides,
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
  // Same registration as registerV2Routes: the actor-scoped plugin twice,
  // the /actor-builds plugin once (registering it per segment would throw a
  // duplicate-route error here).
  await app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'acts' });
  await app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'actors' });
  await app.register(actorBuildsRoutes, { prefix: '/v2' });
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

describe('GET /v2/acts/:actorId/builds/default', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQuery.mockReset();
    mockResolveActor.mockReset();
    mockResolveActor.mockResolvedValue({ rows: [OWN_ACTOR] });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['acts', 'actors'])(
    'returns the default build with its actorDefinition (/v2/%s)',
    async (segment) => {
      mockQuery.mockResolvedValueOnce({ rows: [buildRow()] });

      const res = await app.inject({ method: 'GET', url: `/v2/${segment}/alice~x/builds/default` });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data).toMatchObject({
        id: 'build-1',
        actId: 'actor-1',
        userId: 'test-user-id',
        buildNumber: '0.1.2',
        status: 'SUCCEEDED',
        meta: {},
        stats: {},
        options: {},
      });
      expect(data.actorDefinition).toEqual(definition);

      const [, resolveParams] = mockResolveActor.mock.calls[0] as [string, unknown[]];
      expect(resolveParams.slice(0, 2)).toEqual(['alice~x', 'test-user-id']);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['actor-1']);
      // Only SUCCEEDED builds; the `latest` version's first, newest first.
      expect(sql).toContain("b.status = 'SUCCEEDED'");
      expect(sql).toMatch(
        /ORDER BY COALESCE\(v\.build_tag = 'latest', false\) DESC,\s+b\.created_at DESC/
      );
      expect(sql).toContain('b.actor_definition');
      expect(sql).toContain('LIMIT 1');
    }
  );

  it('returns 404 record-not-found when the actor has no successful build', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/v2/acts/actor-1/builds/default' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('record-not-found');
  });

  it('returns 404 for an actor the caller does not own, without a build query', async () => {
    mockResolveActor.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/v2/acts/bob~x/builds/default' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('record-not-found');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid waitForFinish with 400 before any query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/acts/actor-1/builds/default?waitForFinish=abc',
    });
    expect(res.statusCode).toBe(400);
    expect(mockResolveActor).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns a SUCCEEDED default build immediately even with waitForFinish', async () => {
    mockQuery.mockResolvedValue({ rows: [buildRow()] });

    const res = await app.inject({
      method: 'GET',
      url: '/v2/acts/actor-1/builds/default?waitForFinish=60',
    });

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('GET /v2/actor-builds/:buildId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQuery.mockReset();
    mockResolveActor.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the build scoped to the caller through its actor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buildRow()] });

    const res = await app.inject({ method: 'GET', url: '/v2/actor-builds/build-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.actorDefinition).toEqual(definition);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['build-1', 'test-user-id']);
    expect(sql).toContain('JOIN actors a ON a.id = b.actor_id');
    expect(sql).toContain('a.user_id = $2');
    expect(sql).toContain('b.actor_definition');
  });

  it('returns actorDefinition: null for a build pushed without one', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buildRow({ actor_definition: null })] });

    const res = await app.inject({ method: 'GET', url: '/v2/actor-builds/build-1' });

    expect(res.json().data).toHaveProperty('actorDefinition', null);
  });

  it("returns 404 record-not-found for a missing (or another user's) build", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/v2/actor-builds/bobs-build' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('record-not-found');
  });
});

describe('GET /v2/actor-builds/:buildId?waitForFinish (fake timers)', () => {
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
    mockQuery.mockResolvedValue({ rows: [buildRow({ status: 'RUNNING' })] });
    const res = await app.inject({ method: 'GET', url: '/v2/actor-builds/build-1' });
    expect(res.json().data.status).toBe('RUNNING');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('responds as soon as the build becomes terminal', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [buildRow({ status: 'RUNNING' })] })
      .mockResolvedValueOnce({ rows: [buildRow({ status: 'RUNNING' })] })
      .mockResolvedValueOnce({ rows: [buildRow({ status: 'RUNNING' })] })
      .mockResolvedValue({ rows: [buildRow({ status: 'FAILED' })] });

    const probe = track(
      app.inject({ method: 'GET', url: '/v2/actor-builds/build-1?waitForFinish=20' })
    );
    await vi.advanceTimersByTimeAsync(2_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
    expect(probe.value.json().data.status).toBe('FAILED');
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it('responds with the RUNNING state after waitForFinish seconds (orphan build)', async () => {
    mockQuery.mockResolvedValue({ rows: [buildRow({ status: 'RUNNING' })] });

    const probe = track(
      app.inject({ method: 'GET', url: '/v2/actor-builds/build-1?waitForFinish=5' })
    );
    await vi.advanceTimersByTimeAsync(4_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
    expect(probe.value.json().data.status).toBe('RUNNING');
  });

  it('clamps waitForFinish=600 to 60s', async () => {
    mockQuery.mockResolvedValue({ rows: [buildRow({ status: 'RUNNING' })] });

    const probe = track(
      app.inject({ method: 'GET', url: '/v2/actor-builds/build-1?waitForFinish=600' })
    );
    await vi.advanceTimersByTimeAsync(59_900);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.settled).toBe(true);
  });

  it('returns 404 immediately for an unknown build', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/v2/actor-builds/nope?waitForFinish=20',
    });
    expect(res.statusCode).toBe(404);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', 'abc', '2.5'])('rejects waitForFinish=%s with 400', async (v) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v2/actor-builds/build-1?waitForFinish=${v}`,
    });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('formatBuild', () => {
  it('keeps the dashboard fields and adds the Apify ones', () => {
    const row = buildRow();
    const formatted = formatBuild(row);
    // Original shape (packages/dashboard/src/lib/api.ts) — unchanged.
    expect(formatted).toMatchObject({
      id: row.id,
      actorId: row.actor_id,
      versionId: row.version_id,
      versionNumber: '0.1',
      buildTag: 'latest',
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      imageName: row.image_name,
      imageDigest: null,
      imageSizeBytes: null,
      logCount: 0,
      gitBranch: null,
      gitCommit: null,
      createdAt: row.created_at,
    });
    expect(formatted).toMatchObject({
      actId: 'actor-1',
      userId: 'test-user-id',
      buildNumber: '0.1.2',
      meta: {},
      stats: {},
      options: {},
      actorDefinition: definition,
    });
  });

  it('omits actorDefinition when the query did not select it (lists)', () => {
    const { actor_definition: _omit, ...row } = buildRow();
    expect(formatBuild(row)).not.toHaveProperty('actorDefinition');
  });
});

describe('selectDefaultBuilds', () => {
  beforeEach(() => mockQuery.mockReset());

  it('selects many actors’ default builds in one LATERAL query', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [buildRow(), buildRow({ id: 'build-9', actor_id: 'actor-2' })],
    });

    const builds = await selectDefaultBuilds(['actor-1', 'actor-2', 'actor-1', 'actor-3']);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('CROSS JOIN LATERAL');
    expect(sql).toContain('b.actor_id = ids.actor_id');
    expect(params).toEqual([['actor-1', 'actor-2', 'actor-3']]);
    expect(builds.get('actor-1')?.id).toBe('build-1');
    expect(builds.get('actor-2')?.id).toBe('build-9');
    expect(builds.has('actor-3')).toBe(false);
  });

  it('can skip actor_definition', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await selectDefaultBuilds(['actor-1'], { definition: false });
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('actor_definition');
  });

  it('runs no query for an empty list', async () => {
    expect((await selectDefaultBuilds([])).size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
