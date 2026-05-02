/**
 * Webhook Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { webhooksRoutes } from '../src/routes/webhooks.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
  pool: { query: vi.fn() },
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    publish: vi.fn(),
  },
}));

const createWebhookRow = (overrides = {}) => ({
  id: 'webhook-1',
  user_id: 'test-user-id',
  event_types: ['ACTOR.RUN.SUCCEEDED'],
  request_url: 'https://example.com/hook',
  payload_template: null,
  actor_id: null,
  headers: null,
  description: 'Test webhook',
  is_enabled: true,
  created_at: new Date(),
  modified_at: new Date(),
  ...overrides,
});

const createDeliveryRow = (overrides = {}) => ({
  id: 'delivery-1',
  webhook_id: 'webhook-1',
  run_id: 'run-1',
  event_type: 'ACTOR.RUN.SUCCEEDED',
  status: 'DELIVERED',
  attempt_count: 1,
  max_attempts: 3,
  next_retry_at: null,
  response_status: 200,
  response_body: '{"ok":true}',
  created_at: new Date(),
  finished_at: new Date(),
  ...overrides,
});

describe('Webhook Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
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
    app.register(webhooksRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('POST /v2/webhooks', () => {
    it('should create a webhook', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createWebhookRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks',
        payload: {
          eventTypes: ['ACTOR.RUN.SUCCEEDED'],
          requestUrl: 'https://example.com/hook',
          description: 'Test webhook',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('webhook-1');
      expect(body.data.eventTypes).toEqual(['ACTOR.RUN.SUCCEEDED']);
      expect(body.data.requestUrl).toBe('https://example.com/hook');
      expect(body.data.isEnabled).toBe(true);
    });

    it('should reject invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks',
        payload: {
          eventTypes: [],
          requestUrl: 'not-a-url',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v2/webhooks', () => {
    it('should list user webhooks', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          createWebhookRow(),
          createWebhookRow({ id: 'webhook-2', description: 'Second webhook' }),
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
      expect(body.data.offset).toBe(0);
      expect(body.data.limit).toBe(100);
    });

    it('should return empty list when no webhooks exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });
  });

  describe('GET /v2/webhooks/:webhookId', () => {
    it('should get webhook by id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createWebhookRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks/webhook-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('webhook-1');
    });

    it('should return 404 for non-existent webhook', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks/non-existent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Webhook not found');
    });
  });

  describe('PUT /v2/webhooks/:webhookId', () => {
    it('should update webhook', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createWebhookRow({ description: 'Updated description' })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/webhooks/webhook-1',
        payload: { description: 'Updated description' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.description).toBe('Updated description');
    });

    it('should return 404 for non-existent webhook', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/webhooks/non-existent',
        payload: { description: 'Updated' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v2/webhooks/:webhookId', () => {
    it('should delete webhook', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'webhook-1' }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/webhooks/webhook-1',
      });

      expect(response.statusCode).toBe(204);
    });

    it('should return 404 for missing webhook', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/webhooks/non-existent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Webhook not found');
    });
  });

  describe('GET /v2/webhooks/:webhookId/deliveries', () => {
    it('should list webhook deliveries', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createWebhookRow()] }) // ownership check
        .mockResolvedValueOnce({ rows: [createDeliveryRow()] }) // deliveries
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // count

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks/webhook-1/deliveries',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe('delivery-1');
      expect(body.data.items[0].status).toBe('DELIVERED');
      expect(body.data.total).toBe(1);
    });

    it('should return 404 when webhook not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check fails

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks/non-existent/deliveries',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should support pagination parameters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createWebhookRow()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/webhooks/webhook-1/deliveries?offset=10&limit=5',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.offset).toBe(10);
      expect(body.data.limit).toBe(5);
    });
  });

  describe('POST /v2/webhooks/:webhookId/test', () => {
    // Stub global fetch so we don't actually hit any URL during tests.
    const originalFetch = global.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof global.fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it('returns DELIVERED with the response status when receiver accepts the test event', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createWebhookRow()] }) // ownership lookup
        .mockResolvedValueOnce({
          rows: [
            createDeliveryRow({ status: 'PENDING', response_status: null, response_body: null }),
          ],
        }) // INSERT ... RETURNING (initial PENDING row)
        .mockResolvedValueOnce({
          rows: [
            createDeliveryRow({ status: 'DELIVERED', response_status: 200, response_body: 'ok' }),
          ],
        }); // UPDATE ... RETURNING (final DELIVERED row)

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'ok',
      } as Response);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: { status: string; responseStatus: number };
      };
      expect(body.data.status).toBe('DELIVERED');
      expect(body.data.responseStatus).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://example.com/hook');
      const payload = JSON.parse(init.body as string) as { test: boolean; eventType: string };
      // Test payload must self-identify so receivers can opt out of side effects.
      expect(payload.test).toBe(true);
      expect(payload.eventType).toBe('ACTOR.RUN.SUCCEEDED');
    });

    it('returns FAILED with the receiver error body when delivery returns non-2xx', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createWebhookRow()] })
        .mockResolvedValueOnce({ rows: [createDeliveryRow({ status: 'PENDING' })] })
        .mockResolvedValueOnce({
          rows: [
            createDeliveryRow({
              status: 'FAILED',
              response_status: 503,
              response_body: 'service unavailable',
            }),
          ],
        });

      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      } as Response);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
      });

      // Use 502 to signal "test fired but the receiver rejected it" — distinct
      // from 200 (success) and 5xx-on-our-side (we didn't even reach them).
      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body) as {
        data: { status: string; responseStatus: number; responseBody: string };
      };
      expect(body.data.status).toBe('FAILED');
      expect(body.data.responseStatus).toBe(503);
      expect(body.data.responseBody).toBe('service unavailable');
    });

    it('blocks private/loopback URLs without sending the request', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [createWebhookRow({ request_url: 'http://localhost:9999/hook' })],
        })
        .mockResolvedValueOnce({ rows: [createDeliveryRow({ status: 'PENDING' })] })
        .mockResolvedValueOnce({
          rows: [
            createDeliveryRow({
              status: 'FAILED',
              response_status: null,
              response_body: 'Webhook URL targets a private/internal network address',
            }),
          ],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
      });

      expect(response.statusCode).toBe(502);
      // Critical: fetch must NOT be called for private targets — that's what
      // makes the SSRF guard meaningful, not the resulting status row.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 404 when the webhook is owned by a different user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check fails

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/foreign/test',
      });

      expect(response.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the requested eventType from the body when subscribed', async () => {
      // Multi-event webhook with [SUCCEEDED, FAILED]. Test that requesting
      // FAILED specifically picks FAILED, not the first event (SUCCEEDED).
      const subscribed = ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'];
      mockQuery
        .mockResolvedValueOnce({ rows: [createWebhookRow({ event_types: subscribed })] })
        .mockResolvedValueOnce({
          rows: [createDeliveryRow({ status: 'PENDING', event_type: 'ACTOR.RUN.FAILED' })],
        })
        .mockResolvedValueOnce({
          rows: [
            createDeliveryRow({
              status: 'DELIVERED',
              event_type: 'ACTOR.RUN.FAILED',
              response_status: 200,
              response_body: 'ok',
            }),
          ],
        });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' } as Response);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
        payload: { eventType: 'ACTOR.RUN.FAILED' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { data: { eventType: string } };
      expect(body.data.eventType).toBe('ACTOR.RUN.FAILED');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const payload = JSON.parse(init.body as string) as { eventType: string };
      expect(payload.eventType).toBe('ACTOR.RUN.FAILED');
    });

    it('synthetic test payload has the Apify-compatible shape with a full resource block', async () => {
      // Locks the wire contract receivers depend on. KEEP IN SYNC with the
      // runner's attemptWebhookDelivery default payload (queue.ts) — both
      // endpoints must produce the same shape so receivers tested with the
      // dashboard work in production unchanged.
      const subscribed = ['ACTOR.RUN.SUCCEEDED'];
      mockQuery
        .mockResolvedValueOnce({
          rows: [createWebhookRow({ event_types: subscribed, user_id: 'owner-123' })],
        })
        .mockResolvedValueOnce({ rows: [createDeliveryRow({ status: 'PENDING' })] })
        .mockResolvedValueOnce({
          rows: [createDeliveryRow({ status: 'DELIVERED', response_status: 200 })],
        });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' } as Response);

      await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
        payload: { eventType: 'ACTOR.RUN.SUCCEEDED' },
      });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const sent = JSON.parse(init.body as string) as Record<string, unknown>;

      // Top-level shape (Apify webhook docs)
      expect(sent).toMatchObject({
        userId: 'owner-123',
        eventType: 'ACTOR.RUN.SUCCEEDED',
        test: true,
      });
      expect(sent.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sent.eventData).toMatchObject({
        actorId: expect.any(String),
        actorRunId: expect.any(String),
      });

      // Resource block — full run context. Receivers branch on these fields.
      const resource = sent.resource as Record<string, unknown>;
      expect(resource).toMatchObject({
        id: expect.any(String),
        actId: expect.any(String),
        userId: 'owner-123',
        status: 'SUCCEEDED',
        defaultDatasetId: expect.stringMatching(/^test-dataset-/),
        defaultKeyValueStoreId: expect.stringMatching(/^test-kv-/),
        defaultRequestQueueId: expect.stringMatching(/^test-rq-/),
        options: { timeoutSecs: 3600, memoryMbytes: 1024 },
        exitCode: 0, // SUCCEEDED → exit 0
        stats: {
          inputBodyLen: 0,
          restartCount: 0,
          resurrectCount: 0,
          runTimeSecs: expect.any(Number),
          computeUnits: 0,
        },
      });
      expect(resource.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(resource.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('exitCode reflects the eventType for terminal states', async () => {
      // FAILED/TIMED-OUT/ABORTED → non-zero exit. SUCCEEDED → 0. RUNNING → null.
      const cases = [
        { eventType: 'ACTOR.RUN.SUCCEEDED', expectedExit: 0 },
        { eventType: 'ACTOR.RUN.FAILED', expectedExit: 1 },
        { eventType: 'ACTOR.RUN.TIMED-OUT', expectedExit: 1 },
        { eventType: 'ACTOR.RUN.ABORTED', expectedExit: 1 },
      ];
      for (const { eventType, expectedExit } of cases) {
        mockQuery
          .mockResolvedValueOnce({ rows: [createWebhookRow({ event_types: [eventType] })] })
          .mockResolvedValueOnce({ rows: [createDeliveryRow({ status: 'PENDING' })] })
          .mockResolvedValueOnce({
            rows: [createDeliveryRow({ status: 'DELIVERED', response_status: 200 })],
          });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => 'ok',
        } as Response);

        await app.inject({
          method: 'POST',
          url: '/v2/webhooks/webhook-1/test',
          payload: { eventType },
        });
        const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        const sent = JSON.parse(init.body as string) as { resource: { exitCode: number | null } };
        expect(sent.resource.exitCode).toBe(expectedExit);
      }
    });

    it('resource.status matches the requested eventType across all terminal states', async () => {
      // Regression: status used to be hardcoded to 'SUCCEEDED' regardless of
      // eventType, so a FAILED test fired an inconsistent payload at the
      // receiver (eventType=FAILED, status=SUCCEEDED). Status now lives in
      // resource.status (Apify-compat shape), and is derived from eventType.
      const cases: { eventType: string; expectedStatus: string }[] = [
        { eventType: 'ACTOR.RUN.FAILED', expectedStatus: 'FAILED' },
        { eventType: 'ACTOR.RUN.TIMED-OUT', expectedStatus: 'TIMED-OUT' },
        { eventType: 'ACTOR.RUN.ABORTED', expectedStatus: 'ABORTED' },
        { eventType: 'ACTOR.RUN.SUCCEEDED', expectedStatus: 'SUCCEEDED' },
      ];

      for (const { eventType, expectedStatus } of cases) {
        mockQuery
          .mockResolvedValueOnce({ rows: [createWebhookRow({ event_types: [eventType] })] })
          .mockResolvedValueOnce({
            rows: [createDeliveryRow({ status: 'PENDING', event_type: eventType })],
          })
          .mockResolvedValueOnce({
            rows: [
              createDeliveryRow({
                status: 'DELIVERED',
                event_type: eventType,
                response_status: 200,
              }),
            ],
          });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => 'ok',
        } as Response);

        const response = await app.inject({
          method: 'POST',
          url: '/v2/webhooks/webhook-1/test',
          payload: { eventType },
        });

        expect(response.statusCode).toBe(200);
        const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        const sentPayload = JSON.parse(init.body as string) as {
          eventType: string;
          resource: { status: string };
        };
        expect(sentPayload.eventType).toBe(eventType);
        expect(sentPayload.resource.status).toBe(expectedStatus);
      }
    });

    it('rejects an eventType the webhook is not subscribed to', async () => {
      // Receivers shouldn't have to handle events the platform "promised" not
      // to send them. The test endpoint enforces subscription scope.
      mockQuery.mockResolvedValueOnce({
        rows: [createWebhookRow({ event_types: ['ACTOR.RUN.SUCCEEDED'] })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/webhooks/webhook-1/test',
        payload: { eventType: 'ACTOR.BUILD.FAILED' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid-event-type');
      expect(body.error.message).toContain('ACTOR.BUILD.FAILED');
      expect(body.error.message).toContain('ACTOR.RUN.SUCCEEDED');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
