/**
 * Actor Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { ZodError } from 'zod';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { actorsRoutes } from '../src/routes/actors.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockRedisPublish = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: (...args: unknown[]) => mockRedisPublish(...args),
  },
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

const createActorRow = (overrides = {}) => ({
  id: 'actor-1',
  name: 'test-actor',
  user_id: null,
  title: 'Test Actor',
  description: 'A test actor',
  default_run_options: null,
  proxy_password_encrypted: null,
  created_at: new Date(),
  modified_at: new Date(),
  ...overrides,
});

describe('Actor Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // Mirror the prod ZodError handler from src/index.ts so validation
    // failures surface as 400 (not 500). Required for tests that assert
    // schema-level rejection — e.g. unsupported webhook event types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.setErrorHandler((error: any, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            type: 'validation_error',
            message: 'Validation failed',
            details: error.errors,
          },
        });
      }
      reply.status(500).send({ error: { message: error.message } });
    });
    app.register(actorsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRedisPublish.mockReset();
  });

  describe('GET /v2/acts', () => {
    it('should list actors with real total from COUNT(*)', async () => {
      // Two parallel queries: COUNT then page. Promise.all calls them in
      // array order so the mock queue must answer COUNT first.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '142' }] }).mockResolvedValueOnce({
        rows: [createActorRow(), createActorRow({ id: 'actor-2', name: 'actor-2' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(142); // real COUNT, not the page length
      expect(body.data.count).toBe(2);
      expect(body.data.offset).toBe(0);
      expect(body.data.limit).toBe(100);
    });

    it('honours ?offset and ?limit query params', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '500' }] })
        .mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts?offset=200&limit=50',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.total).toBe(500);
      expect(body.data.offset).toBe(200);
      expect(body.data.limit).toBe(50);
      // The SELECT mock call (call #2) should have been issued with the
      // parsed offset and limit as the trailing parameters.
      const pageCallArgs = mockQuery.mock.calls[1];
      expect(pageCallArgs?.[1]).toEqual([expect.any(String), 50, 200]);
    });

    it('honours ?q for substring search across (id, name, title, description)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '3' }] })
        .mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts?q=scraper',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.total).toBe(3);

      // Both COUNT and SELECT carry the same wrapped pattern as the second
      // bind param. ILIKE wildcards are added by SQL, not user-controlled.
      const countSql = mockQuery.mock.calls[0]?.[0] as string;
      expect(countSql).toContain('ILIKE');
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['test-user-id', '%scraper%']);

      const pageSql = mockQuery.mock.calls[1]?.[0] as string;
      expect(pageSql).toContain('ILIKE');
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['test-user-id', '%scraper%', 100, 0]);
    });

    it('escapes LIKE metacharacters in ?q so user-typed % stays literal', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await app.inject({ method: 'GET', url: '/v2/acts?q=100%25price_tag' });

      // %25 → '%' after URL decode; the LIKE-escape then turns each metachar
      // into its escaped form so PG matches them literally.
      const pageCallArgs = mockQuery.mock.calls[1]?.[1] as unknown[];
      expect(pageCallArgs[1]).toBe('%100\\%price\\_tag%');
    });

    it('skips the WHERE clause entirely when ?q is whitespace-only', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '5' }] })
        .mockResolvedValueOnce({ rows: [] });

      await app.inject({ method: 'GET', url: '/v2/acts?q=%20%20' });

      const countSql = mockQuery.mock.calls[0]?.[0] as string;
      expect(countSql).not.toContain('ILIKE');
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['test-user-id']);
    });
  });

  describe('POST /v2/acts', () => {
    it('should create new actor', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // no existing
        .mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'test-actor', title: 'Test Actor' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('test-actor');
    });

    it('should update existing actor', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createActorRow()] }) // existing
        .mockResolvedValueOnce({ rows: [createActorRow({ title: 'Updated Title' })] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'test-actor', title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should accept image and envVars in defaultRunOptions', async () => {
      const defaultRunOptions = {
        image: 'ghcr.io/example/repo/actor-foo:latest',
        envVars: { BASE_URL: 'https://example.com', API_KEY: 'secret' },
        timeoutSecs: 600,
      };
      const stored = createActorRow({
        default_run_options: defaultRunOptions,
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [stored] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'foo', defaultRunOptions },
      });

      expect(response.statusCode).toBe(201);
      const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
      const storedJson = insertCall[1][5] as string;
      const parsed = JSON.parse(storedJson) as typeof defaultRunOptions;
      expect(parsed.image).toBe(defaultRunOptions.image);
      expect(parsed.envVars).toEqual(defaultRunOptions.envVars);
      expect(parsed.timeoutSecs).toBe(600);
    });

    it('rejects defaultRunOptions.timeoutSecs above the per-run cap (86400)', async () => {
      // Cap mismatch fix: CreateActorSchema previously allowed any
      // positive timeoutSecs, while ActorRunSchema caps explicit run
      // timeouts at 86400s. Since the same-PR fix now propagates actor
      // defaults to runs, the uncapped path would let operators bypass
      // the run-time guardrail. The schema now applies the same cap.
      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: {
          name: 'long-running',
          defaultRunOptions: { timeoutSecs: 200_000 },
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects defaultRunOptions.memoryMbytes above the per-run cap (16384)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: {
          name: 'fat-actor',
          defaultRunOptions: { memoryMbytes: 100_000 },
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('persists proxyPassword (encrypted) on create — regression for Codex P2', async () => {
      // The earlier version of this code accepted proxyPassword in
      // CreateActorSchema but the INSERT silently dropped the field.
      // Verify the encrypted blob lands in the INSERT call args, and
      // the plaintext does not.
      process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'foo', proxyPassword: 'apify_secret_pw_create' },
      });

      expect(response.statusCode).toBe(201);
      const insertArgs = (mockQuery.mock.calls[1] as [string, unknown[]])[1];
      expect(insertArgs).not.toContain('apify_secret_pw_create');
      expect(insertArgs.some((a) => typeof a === 'string' && /^v1:/.test(a))).toBe(true);
    });

    it('persists proxyPassword (encrypted) on upsert into an existing actor', async () => {
      process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);
      mockQuery
        .mockResolvedValueOnce({ rows: [createActorRow()] }) // existing
        .mockResolvedValueOnce({ rows: [createActorRow({ proxy_password_encrypted: 'v1:x' })] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'test-actor', proxyPassword: 'apify_secret_pw_upsert' },
      });

      expect(response.statusCode).toBe(200);
      const updateArgs = (mockQuery.mock.calls[1] as [string, unknown[]])[1];
      expect(updateArgs).not.toContain('apify_secret_pw_upsert');
      expect(updateArgs.some((a) => typeof a === 'string' && /^v1:/.test(a))).toBe(true);
    });
  });

  describe('GET /v2/acts/:actorId', () => {
    it('should get actor by id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/actor-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('actor-1');
    });

    it('should return 404 for non-existent actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /v2/acts/:actorId', () => {
    it('should update actor', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow({ title: 'New Title' })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/acts/actor-1',
        payload: { title: 'New Title' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should persist defaultRunOptions on update', async () => {
      const dro = {
        image: 'ghcr.io/example/repo/actor-foo:latest',
        envVars: { BASE_URL: 'https://example.com' },
      };
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow({ default_run_options: dro })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/acts/actor-1',
        payload: { defaultRunOptions: dro },
      });

      expect(response.statusCode).toBe(200);
      const updateCall = mockQuery.mock.calls[0] as [string, unknown[]];
      const sql = updateCall[0];
      expect(sql).toMatch(/default_run_options = \$/);
      const storedJson = updateCall[1].find(
        (v) => typeof v === 'string' && v.includes('"image"')
      ) as string;
      expect(JSON.parse(storedJson)).toEqual(dro);
    });

    it('PUT with proxyPassword stores encrypted blob, never plaintext', async () => {
      process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow({ proxy_password_encrypted: 'v1:x' })],
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/v2/acts/actor-1',
        headers: { authorization: 'Bearer valid-token' },
        payload: { proxyPassword: 'apify_secret_pw' },
      });
      expect(res.statusCode).toBe(200);
      const args = mockQuery.mock.calls[0][1] as unknown[];
      expect(args).not.toContain('apify_secret_pw');
      expect(args.some((a) => typeof a === 'string' && /^v1:/.test(a))).toBe(true);
    });

    it('PUT with proxyPassword: null clears the column', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow({ proxy_password_encrypted: null })],
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/v2/acts/actor-1',
        headers: { authorization: 'Bearer valid-token' },
        payload: { proxyPassword: null },
      });
      expect(res.statusCode).toBe(200);
      const args = mockQuery.mock.calls[0][1] as unknown[];
      expect(args).toContain(null);
    });

    it('GET response includes hasProxyOverride and never the password value', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow({ proxy_password_encrypted: 'v1:secret-blob' })],
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v2/acts/actor-1',
        headers: { authorization: 'Bearer valid-token' },
      });
      const body = res.json();
      expect(body.data.hasProxyOverride).toBe(true);
      expect(JSON.stringify(body)).not.toContain('v1:secret-blob');
      expect(JSON.stringify(body)).not.toContain('proxy_password_encrypted');
    });
  });

  describe('DELETE /v2/acts/:actorId', () => {
    it('should delete actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/acts/actor-1',
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('POST /v2/acts/:actorId/runs', () => {
    it('should start actor run', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createActorRow()] }) // get actor
        .mockResolvedValueOnce({ rows: [] }) // dataset insert
        .mockResolvedValueOnce({ rows: [] }) // kv store insert
        .mockResolvedValueOnce({ rows: [] }) // queue insert
        // Build lookup: actor has no SUCCEEDED build → null buildId/buildNumber.
        // Both columns are nullable so the run insert below stays valid.
        .mockResolvedValueOnce({ rows: [] })
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
              created_at: new Date(),
            },
          ],
        });

      mockRedisPublish.mockResolvedValueOnce(1);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        payload: { input: { url: 'https://example.com' } },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('READY');
      expect(mockRedisPublish).toHaveBeenCalledWith('run:new', expect.any(String));
    });

    it('should return 404 for non-existent actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/non-existent/runs',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it("inherits timeout/memory from actor's default_run_options when request body omits them", async () => {
      // Actor configured with timeoutSecs=7200, memoryMbytes=4096
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            createActorRow({
              default_run_options: { timeoutSecs: 7200, memoryMbytes: 4096 },
            }),
          ],
        }) // get actor
        .mockResolvedValueOnce({ rows: [] }) // dataset
        .mockResolvedValueOnce({ rows: [] }) // kv
        .mockResolvedValueOnce({ rows: [] }) // queue
        .mockResolvedValueOnce({ rows: [] }) // build lookup
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'run-1',
              actor_id: 'actor-1',
              status: 'READY',
              started_at: null,
              default_dataset_id: 'ds',
              default_key_value_store_id: 'kv',
              default_request_queue_id: 'rq',
              timeout_secs: 7200,
              memory_mbytes: 4096,
              created_at: new Date(),
            },
          ],
        }); // run INSERT

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        payload: {}, // no timeout/memory in body
      });

      expect(response.statusCode).toBe(201);
      // The run INSERT (last mockQuery call) must bind 7200 and 4096, not 3600 and 1024
      const insertCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [
        string,
        unknown[],
      ];
      expect(insertCall[0]).toContain('INSERT INTO runs');
      expect(insertCall[1]).toContain(7200); // timeout_secs
      expect(insertCall[1]).toContain(4096); // memory_mbytes
    });

    it('request body timeout/memory override actor defaults', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            createActorRow({
              default_run_options: { timeoutSecs: 7200, memoryMbytes: 4096 },
            }),
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'run-1',
              actor_id: 'actor-1',
              status: 'READY',
              started_at: null,
              default_dataset_id: 'ds',
              default_key_value_store_id: 'kv',
              default_request_queue_id: 'rq',
              timeout_secs: 1800,
              memory_mbytes: 2048,
              created_at: new Date(),
            },
          ],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        payload: { timeout: 1800, memory: 2048 },
      });

      expect(response.statusCode).toBe(201);
      const insertCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [
        string,
        unknown[],
      ];
      expect(insertCall[1]).toContain(1800);
      expect(insertCall[1]).toContain(2048);
      expect(insertCall[1]).not.toContain(7200);
    });

    it('falls back to 3600/1024 when neither request body nor actor defaults set timeout/memory', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [createActorRow({ default_run_options: null })],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'run-1',
              actor_id: 'actor-1',
              status: 'READY',
              started_at: null,
              default_dataset_id: 'ds',
              default_key_value_store_id: 'kv',
              default_request_queue_id: 'rq',
              timeout_secs: 3600,
              memory_mbytes: 1024,
              created_at: new Date(),
            },
          ],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      const insertCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [
        string,
        unknown[],
      ];
      expect(insertCall[1]).toContain(3600);
      expect(insertCall[1]).toContain(1024);
    });

    it('accepts a per-run webhooks array and persists rows scoped to run_id', async () => {
      // 1. Actor lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'actor-1', name: 'bravo-com', user_id: 'test-user-id' }],
      });
      // 2-4. Storage inserts (datasets, kv, request_queues) — return empty rows
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // 5. Build lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ build_id: 'build-1', version_number: '0.0' }] });
      // 6. Run INSERT
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'run-1',
            actor_id: 'actor-1',
            status: 'READY',
            started_at: new Date(),
            default_dataset_id: 'ds-1',
            default_key_value_store_id: 'kv-1',
            default_request_queue_id: 'rq-1',
            timeout_secs: 3600,
            memory_mbytes: 1024,
            created_at: new Date(),
          },
        ],
      });
      // 7. Per-run webhook INSERT
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // 8. redis.publish('run:new', ...) — required, otherwise undefined
      mockRedisPublish.mockResolvedValueOnce(1);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/bravo-com/runs',
        payload: {
          input: { startUrls: [] },
          timeout: 3600,
          memory: 1024,
          webhooks: [
            {
              eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
              requestUrl: 'https://client.example.com/webhooks/items',
              payloadTemplate: '{"sourceId":"abc","resource":{{resource}}}',
              headersTemplate: '{"Authorization":"Bearer secret"}',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      // Find the per-run webhook INSERT call. `if (!x) throw` narrows TS
      // so the [1] dereference type-checks; toBeDefined() doesn't narrow.
      const webhookInsertCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO webhooks')
      );
      if (!webhookInsertCall) throw new Error('per-run webhook INSERT call not made');
      const params = webhookInsertCall[1] as unknown[];
      expect(params).toContain('run-1'); // run_id
      expect(params).toContain(JSON.stringify({ Authorization: 'Bearer secret' })); // parsed headers as JSON string
    });

    it('rejects per-run webhooks subscribing to events Crawlee Cloud does not fire', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'actor-1', name: 'bravo-com', user_id: 'test-user-id' }],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/bravo-com/runs',
        payload: {
          webhooks: [
            {
              eventTypes: ['ACTOR.RUN.RESURRECTED'],
              requestUrl: 'https://example.com/hook',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
