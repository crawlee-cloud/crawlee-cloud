/**
 * /v2/actors alias tests (#109).
 *
 * apify-client >= 2.23.4 addresses actors as /v2/actors/...; older clients use
 * /v2/acts/.... Both segments must hit the same handlers with identical
 * behaviour, including the version and build sub-resources. Each case runs the
 * same mocked DB sequence against both segments and compares the responses.
 *
 * Also covers the platform 404 envelope for unknown routes.
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

import { actorsRoutes } from '../src/routes/actors.js';
import { registryRoutes } from '../src/routes/registry.js';
import { setPlatformNotFoundHandler } from '../src/routes/not-found.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn().mockImplementation(async () => ({
    query: async (text: string, params?: unknown[]) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return mockQuery(text, params);
    },
    release: vi.fn(),
  })),
}));

const mockRedisPublish = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: (...args: unknown[]) => mockRedisPublish(...args),
    rpush: vi.fn(),
    lrange: vi.fn(),
  },
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

const FIXED_DATE = new Date('2026-07-01T00:00:00Z');

const actorRow = (overrides = {}) => ({
  id: 'actor-1',
  name: 'test-actor',
  user_id: null,
  title: 'Test Actor',
  description: 'A test actor',
  default_run_options: null,
  proxy_password_encrypted: null,
  created_at: FIXED_DATE,
  modified_at: FIXED_DATE,
  ...overrides,
});

const versionRow = {
  id: 'ver-1',
  actor_id: 'actor-1',
  version_number: '0.1',
  source_type: 'GIT_REPO',
  source_url: 'https://github.com/example/actor',
  dockerfile: null,
  build_tag: 'latest',
  env_vars: { FOO: 'bar' },
  is_deprecated: false,
  created_at: FIXED_DATE,
};

const buildRow = {
  id: 'build-1',
  actor_id: 'actor-1',
  version_id: 'ver-1',
  status: 'SUCCEEDED',
  started_at: FIXED_DATE,
  finished_at: FIXED_DATE,
  image_name: 'crawlee-cloud/test-actor:build-1',
  image_digest: null,
  image_size_bytes: null,
  log_count: 0,
  git_branch: 'main',
  git_commit: 'abc1234',
  created_at: FIXED_DATE,
  version_number: '0.1',
  build_tag: 'latest',
};

interface AliasCase {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // relative to /v2/<segment>
  payload?: Record<string, unknown>;
  setup: () => void;
  expectedStatus: number;
}

const cases: AliasCase[] = [
  {
    name: 'GET /<segment> lists actors',
    method: 'GET',
    path: '',
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [actorRow()] });
    },
    expectedStatus: 200,
  },
  {
    name: 'POST /<segment> creates an actor',
    method: 'POST',
    path: '',
    payload: { name: 'test-actor', title: 'Test Actor' },
    setup: () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [actorRow()] });
    },
    expectedStatus: 201,
  },
  {
    name: 'GET /<segment>/:id returns the actor',
    method: 'GET',
    path: '/actor-1',
    setup: () => {
      mockQuery.mockResolvedValueOnce({ rows: [actorRow()] });
    },
    expectedStatus: 200,
  },
  {
    name: 'GET /<segment>/:id returns record-not-found for a missing actor',
    method: 'GET',
    path: '/missing',
    setup: () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
    },
    expectedStatus: 404,
  },
  {
    name: 'PUT /<segment>/:id updates the actor',
    method: 'PUT',
    path: '/actor-1',
    payload: { title: 'New Title' },
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [actorRow()] }) // resolve actor
        .mockResolvedValueOnce({ rows: [actorRow({ title: 'New Title' })] });
    },
    expectedStatus: 200,
  },
  {
    name: 'DELETE /<segment>/:id deletes the actor',
    method: 'DELETE',
    path: '/actor-1',
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'actor-1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    },
    expectedStatus: 204,
  },
  {
    name: 'POST /<segment>/:id/runs starts a run',
    method: 'POST',
    path: '/actor-1/runs',
    payload: { input: { url: 'https://example.com' } },
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [actorRow()] }) // get actor
        .mockResolvedValueOnce({ rows: [] }) // dataset insert
        .mockResolvedValueOnce({ rows: [] }) // kv store insert
        .mockResolvedValueOnce({ rows: [] }) // queue insert
        .mockResolvedValueOnce({ rows: [] }) // latest build lookup
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'run-1',
              actor_id: 'actor-1',
              status: 'READY',
              started_at: null,
              default_dataset_id: 'ds-1',
              default_key_value_store_id: 'kv-1',
              default_request_queue_id: 'rq-1',
              timeout_secs: 3600,
              memory_mbytes: 1024,
              created_at: FIXED_DATE,
            },
          ],
        });
      mockRedisPublish.mockResolvedValueOnce(1);
    },
    expectedStatus: 201,
  },
  {
    name: 'GET /<segment>/:id/versions lists versions',
    method: 'GET',
    path: '/actor-1/versions',
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [actorRow()] }) // resolve actor
        .mockResolvedValueOnce({ rows: [versionRow] });
    },
    expectedStatus: 200,
  },
  {
    name: 'GET /<segment>/:id/builds lists builds',
    method: 'GET',
    path: '/actor-1/builds',
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [actorRow()] }) // resolve actor
        .mockResolvedValueOnce({ rows: [buildRow] });
    },
    expectedStatus: 200,
  },
  {
    name: 'GET /<segment>/:id/builds/:buildId returns the build',
    method: 'GET',
    path: '/actor-1/builds/build-1',
    setup: () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [actorRow()] }) // resolve actor
        .mockResolvedValueOnce({ rows: [buildRow] });
    },
    expectedStatus: 200,
  },
];

describe('/v2/actors alias of /v2/acts', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // Mirror registerV2Routes: each actor-scoped plugin registered once per segment.
    app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'acts' });
    app.register(actorsRoutes, { prefix: '/v2', actorsSegment: 'actors' });
    app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'acts' });
    app.register(registryRoutes, { prefix: '/v2', actorsSegment: 'actors' });
    setPlatformNotFoundHandler(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRedisPublish.mockReset();
  });

  async function call(c: AliasCase, segment: 'acts' | 'actors') {
    mockQuery.mockReset();
    mockRedisPublish.mockReset();
    c.setup();
    const response = await app.inject({
      method: c.method,
      url: `/v2/${segment}${c.path}`,
      ...(c.payload ? { payload: c.payload } : {}),
    });
    return {
      statusCode: response.statusCode,
      body: response.body,
      queries: mockQuery.mock.calls.map(([sql]) => sql as string),
    };
  }

  describe.each(cases)('$name', (c) => {
    it.each(['acts', 'actors'] as const)('responds under /v2/%s', async (segment) => {
      const res = await call(c, segment);
      expect(res.statusCode).toBe(c.expectedStatus);
    });

    it('behaves identically under /acts and /actors', async () => {
      const acts = await call(c, 'acts');
      const actors = await call(c, 'actors');
      expect(actors.statusCode).toBe(acts.statusCode);
      expect(actors.queries).toEqual(acts.queries);
      // Run ids and storage ids are random (nanoid) — compare shape for runs,
      // exact bodies everywhere else.
      if (c.path.endsWith('/runs')) {
        expect(Object.keys(JSON.parse(actors.body).data).sort()).toEqual(
          Object.keys(JSON.parse(acts.body).data).sort()
        );
      } else {
        expect(actors.body).toBe(acts.body);
      }
    });
  });

  it('keeps record-not-found for 404s produced inside handlers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await app.inject({ method: 'GET', url: '/v2/actors/missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.type).toBe('record-not-found');
  });

  it('returns the platform envelope with page-not-found for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/v2/nope?x=1' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { type: 'page-not-found', message: 'Route GET /v2/nope not found' },
    });
  });

  it('returns page-not-found for an unknown sub-route under the alias', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/v2/actors/actor-1' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.type).toBe('page-not-found');
  });
});
