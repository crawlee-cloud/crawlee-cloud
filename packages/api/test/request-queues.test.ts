/**
 * Request Queue Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { requestQueuesRoutes } from '../src/routes/request-queues.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn(),
}));

vi.mock('../src/storage/redis.js', () => ({
  addToQueueHead: vi.fn().mockResolvedValue(undefined),
  getQueueHead: vi.fn().mockResolvedValue([]),
  removeFromQueueHead: vi.fn().mockResolvedValue(undefined),
  lockRequest: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  isLocked: vi.fn().mockResolvedValue(false),
}));

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
    app.register(requestQueuesRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /v2/request-queues', () => {
    it('should list queues', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createQueueRow(), createQueueRow({ id: 'queue-2', name: 'queue-2' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/request-queues',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
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
    it('should add request with deduplication', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [] }) // no duplicate
        .mockResolvedValueOnce({ rows: [createRequestRow()] })
        .mockResolvedValueOnce({ rows: [] }); // count update

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues/queue-1/requests',
        payload: { url: 'https://example.com' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.wasAlreadyPresent).toBe(false);
    });

    it('should return existing if duplicate', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createQueueRow()] })
        .mockResolvedValueOnce({ rows: [createRequestRow()] }); // duplicate found

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
  });
});
