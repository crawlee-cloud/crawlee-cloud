/**
 * Request Queue Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { requestQueuesRoutes } from '../src/routes/request-queues.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn(),
}));

const redisMocks = vi.hoisted(() => ({
  addToQueueHead: vi.fn(),
  getQueueHead: vi.fn(),
  removeFromQueueHead: vi.fn(),
  lockRequest: vi.fn(),
  releaseLock: vi.fn(),
  isLocked: vi.fn(),
}));
vi.mock('../src/storage/redis.js', () => redisMocks);

const createQueueRow = (overrides = {}) => ({
  id: 'queue-1',
  name: 'test-queue',
  user_id: null,
  created_at: new Date(),
  modified_at: new Date(),
  accessed_at: new Date(),
  total_request_count: 0,
  handled_request_count: 0,
  pending_request_count: 0,
  ...overrides,
});

const createRequestRow = (overrides = {}) => ({
  id: 'req-1',
  queue_id: 'queue-1',
  unique_key: 'https://example.com',
  url: 'https://example.com',
  method: 'GET',
  payload: null,
  retry_count: 0,
  no_retry: false,
  error_messages: null,
  headers: null,
  user_data: null,
  handled_at: null,
  order_no: 1,
  locked_until: null,
  locked_by: null,
  ...overrides,
});

describe('Request Queue Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // Mirror the prod text/plain parser from src/index.ts (Apify SDK
    // compatibility): the body reaches routes as a raw Buffer, which the
    // batch endpoint handles with its Buffer.isBuffer branch.
    app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    app.register(requestQueuesRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    for (const fn of Object.values(redisMocks)) fn.mockReset();
    redisMocks.addToQueueHead.mockResolvedValue(undefined);
    redisMocks.getQueueHead.mockResolvedValue([]);
    redisMocks.removeFromQueueHead.mockResolvedValue(undefined);
    redisMocks.lockRequest.mockResolvedValue(true);
    redisMocks.releaseLock.mockResolvedValue(true);
    redisMocks.isLocked.mockResolvedValue(false);
  });

  afterEach(() => {
    // Restore spies (e.g. the console.error spy in the batch test below) so
    // route-level console.error stays visible for subsequent tests. The
    // hoisted vi.fn mocks are re-primed in beforeEach, so this is safe.
    vi.restoreAllMocks();
  });

  describe('GET /v2/request-queues', () => {
    it('should list queues with real total from COUNT(*)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '2' }] }).mockResolvedValueOnce({
        rows: [createQueueRow(), createQueueRow({ id: 'queue-2', name: 'queue-2' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });
  });

  describe('GET /v2/request-queues/:queueId', () => {
    it('should get queue by id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues/queue-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('queue-1');
    });

    it('should return 404 for non-existent queue', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues/non-existent',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
    });
  });

  describe('DELETE /v2/request-queues/:queueId', () => {
    it('should delete queue', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/request-queues/queue-1',
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('GET /v2/request-queues/:queueId/head', () => {
    it('should get queue head', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow({ pending_request_count: 5 })] })
        .mockResolvedValueOnce({ rows: [createRequestRow(), createRequestRow({ id: 'req-2' })] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues/queue-1/head?limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
    });
  });

  describe('POST /v2/request-queues/:queueId/head/lock', () => {
    it('should lock and return requests', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow({ had_multiple_clients: false })] }) // queue
        .mockResolvedValueOnce({ rows: [createRequestRow()] }) // pending requests
        .mockResolvedValueOnce({ rows: [] }) // lock update
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // queueHasLockedRequests check
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // hadMultipleClients check

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/head/lock?limit=25&lockSecs=60&clientKey=worker1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.lockSecs).toBe(60);
      expect(body.data.clientKey).toBe('worker1');
      expect(body.data.queueHasLockedRequests).toBe(true);
      expect(body.data.items[0].lockExpiresAt).toBeDefined();
    });
  });

  describe('POST /v2/request-queues/:queueId/requests', () => {
    it('should add request when not yet present (INSERT returns row)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        // INSERT ... ON CONFLICT DO NOTHING RETURNING * — won the race,
        // returns the inserted row.
        .mockResolvedValueOnce({ rows: [createRequestRow()] })
        .mockResolvedValueOnce({ rows: [] }); // counter UPDATE

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests',
        payload: { url: 'https://example.com' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyPresent).toBe(false);
    });

    it('should return existing on conflict (concurrent same-uniqueKey insert)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        // INSERT ... ON CONFLICT DO NOTHING returned empty — duplicate.
        .mockResolvedValueOnce({ rows: [] })
        // Re-fetch by (queue_id, unique_key) returns the existing row.
        .mockResolvedValueOnce({ rows: [createRequestRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests',
        payload: { url: 'https://example.com' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyPresent).toBe(true);
    });
  });

  describe('GET /v2/request-queues/:queueId/requests/:requestId', () => {
    it('should get request', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createRequestRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues/queue-1/requests/req-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('req-1');
    });
  });

  describe('PUT /v2/request-queues/:queueId/requests/:requestId/lock', () => {
    it('should prolong lock', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [createRequestRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1/lock?lockSecs=120&clientKey=worker1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.lockExpiresAt).toBeDefined();
    });
  });

  describe('DELETE /v2/request-queues/:queueId/requests/:requestId/lock', () => {
    it('should release lock', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/request-queues/queue-1/requests/req-1/lock?clientKey=worker1',
      });

      expect(response.statusCode).toBe(204);
    });

    it('returns 404 when the queue does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/request-queues/nope/requests/req-1/lock?clientKey=worker1',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
      expect(redisMocks.releaseLock).not.toHaveBeenCalled();
    });
  });

  describe('POST /v2/request-queues/:queueId/head/lock — contention branches', () => {
    it('excludes requests whose Redis lock is held by another client', async () => {
      // Two candidates; the second one loses the SETNX race.
      redisMocks.lockRequest.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow({ had_multiple_clients: false })] })
        .mockResolvedValueOnce({ rows: [createRequestRow(), createRequestRow({ id: 'req-2' })] })
        .mockResolvedValueOnce({ rows: [] }) // lock UPDATE for req-1 only
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // locked check
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // clients check

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/head/lock?lockSecs=60&clientKey=worker1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe('req-1');
      // Exactly one DB lock UPDATE — the contended request got none.
      const lockUpdates = mockQuery.mock.calls.filter(([sql]) =>
        (sql as string).includes('SET locked_until = NOW()')
      );
      expect(lockUpdates).toHaveLength(1);
    });

    it('marks the queue multi-client on the first second-client sighting', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow({ had_multiple_clients: false })] })
        .mockResolvedValueOnce({ rows: [] }) // no pending requests
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // locked check
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // two distinct clients
        .mockResolvedValueOnce({ rows: [] }); // had_multiple_clients UPDATE

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/head/lock?lockSecs=60&clientKey=worker2',
      });

      const body = JSON.parse(response.body);
      expect(body.data.hadMultipleClients).toBe(true);
      expect(body.data.queueHasLockedRequests).toBe(false);
      const flagUpdate = mockQuery.mock.calls.find(([sql]) =>
        (sql as string).includes('SET had_multiple_clients = true')
      );
      expect(flagUpdate).toBeDefined();
    });

    it('does not rewrite the flag once the queue is already multi-client', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow({ had_multiple_clients: true })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/head/lock?lockSecs=60',
      });

      expect(JSON.parse(response.body).data.hadMultipleClients).toBe(true);
      const flagUpdate = mockQuery.mock.calls.find(([sql]) =>
        (sql as string).includes('SET had_multiple_clients = true')
      );
      expect(flagUpdate).toBeUndefined();
    });

    it('returns 404 for a missing queue', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/nope/head/lock?lockSecs=60',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
    });
  });

  describe('POST /v2/request-queues/:queueId/requests — creation branches', () => {
    it('creates the queue on first use of a named queue id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // queue lookup misses
        .mockResolvedValueOnce({ rows: [] }) // queue INSERT
        .mockResolvedValueOnce({ rows: [createQueueRow({ id: 'my-queue' })] }) // re-select
        .mockResolvedValueOnce({ rows: [createRequestRow({ queue_id: 'my-queue' })] }) // request INSERT
        .mockResolvedValueOnce({ rows: [] }); // counter UPDATE

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/my-queue/requests',
        payload: { url: 'https://example.com' },
      });

      expect(response.statusCode).toBe(201);
      const [insertSql, insertParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(insertSql).toContain('INSERT INTO request_queues');
      // Non-default ids double as the queue name.
      expect(insertParams).toEqual(['my-queue', 'my-queue', 'test-user-id']);
    });

    it('generates a fresh id (null name) for the default queue', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [createRequestRow()] })
        .mockResolvedValueOnce({ rows: [] });

      await app.inject({
        method: 'POST',
        url: '/v2/request-queues/default/requests',
        payload: { url: 'https://example.com' },
      });

      const [, insertParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(insertParams[0]).not.toBe('default');
      expect(insertParams[1]).toBeNull();
    });

    it('scores the head entry negatively for forefront requests', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [createRequestRow({ order_no: 7 })] })
        .mockResolvedValueOnce({ rows: [] });

      await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests?forefront=true',
        payload: { url: 'https://example.com' },
      });

      const [, , score] = redisMocks.addToQueueHead.mock.calls[0] as [string, string, number];
      expect(score).toBe(-7);
    });

    it('returns 500 on the vanishing-row race (no insert, no existing)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] }) // INSERT lost
        .mockResolvedValueOnce({ rows: [] }); // re-fetch also empty

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests',
        payload: { url: 'https://example.com' },
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error.type).toBe('internal-error');
    });

    it('reports wasAlreadyHandled for a duplicate of a handled request', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [createRequestRow({ handled_at: new Date() })] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests',
        payload: { url: 'https://example.com' },
      });

      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyPresent).toBe(true);
      expect(body.data.wasAlreadyHandled).toBe(true);
    });
  });

  describe('POST /v2/request-queues/:queueId/requests/batch', () => {
    it('splits inserts and duplicates, counting only new rows', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] }) // queue lookup
        // Chunk runs in parallel: element 1 inserts, element 2 conflicts.
        .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: 'new-1' }] }))
        .mockImplementationOnce(() => Promise.resolve({ rows: [] }))
        .mockResolvedValueOnce({
          rows: [createRequestRow({ id: 'dup-1', handled_at: new Date() })],
        })
        .mockResolvedValueOnce({ rows: [] }); // counter UPDATE

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests/batch',
        payload: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.processedRequests).toHaveLength(2);
      const [inserted, duplicate] = body.data.processedRequests;
      expect(inserted.wasAlreadyPresent).toBe(false);
      expect(duplicate.wasAlreadyPresent).toBe(true);
      expect(duplicate.wasAlreadyHandled).toBe(true);
      expect(body.data.unprocessedRequests).toHaveLength(0);

      // Only the genuinely-new row bumps the counters.
      const counterCall = mockQuery.mock.calls.find(([sql]) =>
        (sql as string).includes('total_request_count = total_request_count +')
      );
      expect(counterCall?.[1]).toEqual([1, 'queue-1']);
    });

    it('skips the counter update when everything was a duplicate', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] }) // conflict
        .mockResolvedValueOnce({ rows: [createRequestRow({ id: 'dup-1' })] }); // existing

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests/batch',
        payload: [{ url: 'https://a.example.com' }],
      });

      expect(response.statusCode).toBe(200);
      const counterCall = mockQuery.mock.calls.find(([sql]) =>
        (sql as string).includes('total_request_count')
      );
      expect(counterCall).toBeUndefined();
    });

    it('reports a failing element as unprocessed without sinking the batch', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockRejectedValueOnce(new Error('insert exploded'));

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests/batch',
        payload: [{ url: 'https://a.example.com', uniqueKey: 'k1' }],
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.processedRequests).toHaveLength(0);
      expect(body.data.unprocessedRequests).toEqual([
        { url: 'https://a.example.com', uniqueKey: 'k1' },
      ]);
    });

    it('parses a Buffer body delivered by the text/plain parser', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [{ id: 'new-1' }] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests/batch',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify([{ url: 'https://a.example.com' }]),
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data.processedRequests).toHaveLength(1);
    });

    it('treats an unparseable buffer body as an empty batch', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createQueueRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests/batch',
        headers: { 'content-type': 'text/plain' },
        body: 'not-json{',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.processedRequests).toHaveLength(0);
      expect(body.data.unprocessedRequests).toHaveLength(0);
    });
  });

  describe('PUT /v2/request-queues/:queueId/requests/:requestId — update branches', () => {
    it('returns 404 for an unknown request', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/nope',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
    });

    it('rejects an update from a client that does not hold the lock', async () => {
      const lockedRow = createRequestRow({
        locked_until: new Date(Date.now() + 60_000),
        locked_by: 'worker-owner',
      });
      mockQuery.mockResolvedValueOnce({ rows: [lockedRow] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1?clientKey=worker-intruder',
        payload: { retryCount: 1 },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.message).toBe('Request is locked by another client');
      // No UPDATE reached the database.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('lets the lock holder update, and an expired lock does not block', async () => {
      const expiredRow = createRequestRow({
        locked_until: new Date(Date.now() - 1000),
        locked_by: 'worker-old',
      });
      mockQuery.mockResolvedValueOnce({ rows: [expiredRow] }).mockResolvedValueOnce({ rows: [] }); // UPDATE

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1?clientKey=worker-new',
        payload: { retryCount: 2 },
      });

      expect(response.statusCode).toBe(200);
    });

    it('marks handled: bumps counts, clears locks, and prunes the head cache', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createRequestRow()] }) // fetch (unhandled)
        .mockResolvedValueOnce({ rows: [] }) // UPDATE requests
        .mockResolvedValueOnce({ rows: [] }); // counts UPDATE

      const handledAt = new Date().toISOString();
      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1',
        payload: { handledAt },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyHandled).toBe(false);

      const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('handled_at = $1');
      expect(updateSql).toContain('locked_until = NULL');
      expect(updateSql).toContain('locked_by = NULL');
      expect(updateParams[0]).toBe(handledAt);

      const [countSql] = mockQuery.mock.calls[2] as [string];
      expect(countSql).toContain('handled_request_count = handled_request_count + 1');
      expect(redisMocks.removeFromQueueHead).toHaveBeenCalledWith('queue-1', 'req-1');
    });

    it('reclaims without touching counts when handledAt is absent', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createRequestRow()] })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE only

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1',
        payload: { retryCount: 3, errorMessages: ['timeout'] },
      });

      expect(response.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('retry_count = $1');
      expect(updateSql).toContain('error_messages = $2');
      expect(updateSql).not.toContain('handled_at = $');
      expect(updateParams[0]).toBe(3);
      expect(redisMocks.removeFromQueueHead).not.toHaveBeenCalled();
    });

    it('reports an already-handled request without re-bumping counts', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createRequestRow({ handled_at: new Date() })] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/req-1',
        payload: { handledAt: new Date().toISOString() },
      });

      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyHandled).toBe(true);
      // wasHandled=true suppresses the count transition.
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('PUT /v2/request-queues/:queueId/requests/:requestId/lock — 404 branches', () => {
    it('returns 404 when the queue is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/nope/requests/req-1/lock?lockSecs=60',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
    });

    it('returns 404 when the request is missing', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/request-queues/queue-1/requests/nope/lock?lockSecs=60',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
      expect(redisMocks.lockRequest).not.toHaveBeenCalled();
    });
  });

  describe('GET /v2/request-queues/:queueId/requests/:requestId — 404', () => {
    it('returns 404 for an unknown request', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues/queue-1/requests/nope',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('record-not-found');
    });
  });
});
