/**
 * API Compatibility Tests
 * 
 * Tests for Apify SDK compatibility fixes:
 * 1. `name` query param support on POST endpoints
 * 2. `clientKey` validation on request queue updates
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { datasetsRoutes } from '../src/routes/datasets.js';
import { keyValueStoresRoutes } from '../src/routes/key-value-stores.js';
import { requestQueuesRoutes } from '../src/routes/request-queues.js';

// Mock database and storage
const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn(),
  getKVRecord: vi.fn(),
  deleteKVRecord: vi.fn(),
  listKVKeys: vi.fn().mockResolvedValue({ keys: [], isTruncated: false }),
  putDatasetItem: vi.fn(),
  listDatasetItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  kvRecordExists: vi.fn(),
}));

vi.mock('../src/storage/redis.js', () => ({
  addToQueueHead: vi.fn(),
  getQueueHead: vi.fn(),
  removeFromQueueHead: vi.fn(),
  lockRequest: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn(),
  isLocked: vi.fn(),
}));

describe('POST endpoints - name query param support', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(datasetsRoutes, { prefix: '/v2' });
    app.register(keyValueStoresRoutes, { prefix: '/v2' });
    app.register(requestQueuesRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('POST /v2/datasets', () => {
    it('should accept name from query string', async () => {
      // Mock: no existing dataset, then return created one
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // check existing
        .mockResolvedValueOnce({ 
          rows: [{ 
            id: 'test-id', 
            name: 'my-dataset',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            item_count: 0
          }] 
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets?name=my-dataset',
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('my-dataset');
    });

    it('should return existing dataset if name exists', async () => {
      mockQuery.mockResolvedValueOnce({ 
        rows: [{ 
          id: 'existing-id', 
          name: 'existing-dataset',
          user_id: null,
          created_at: new Date(),
          modified_at: new Date(),
          accessed_at: new Date(),
          item_count: 5
        }] 
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets?name=existing-dataset',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('existing-id');
    });
  });

  describe('POST /v2/key-value-stores', () => {
    it('should accept name from query string', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ 
          rows: [{ 
            id: 'kv-id', 
            name: 'my-store',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          }] 
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/key-value-stores?name=my-store',
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('my-store');
    });
  });

  describe('POST /v2/request-queues', () => {
    it('should accept name from query string', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ 
          rows: [{ 
            id: 'queue-id', 
            name: 'my-queue',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            total_request_count: 0,
            handled_request_count: 0,
            pending_request_count: 0,
          }] 
        });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/request-queues?name=my-queue',
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('my-queue');
    });
  });
});

describe('PUT /v2/request-queues/:queueId/requests/:requestId - clientKey validation', () => {
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

  it('should allow update when clientKey matches lock owner', async () => {
    const futureDate = new Date(Date.now() + 60000); // locked for 60 more seconds
    
    mockQuery
      .mockResolvedValueOnce({ 
        rows: [{ 
          id: 'req-1',
          queue_id: 'queue-1',
          unique_key: 'test-url',
          url: 'https://example.com',
          method: 'GET',
          retry_count: 0,
          no_retry: false,
          error_messages: null,
          headers: null,
          user_data: null,
          handled_at: null,
          order_no: 1,
          locked_until: futureDate,
          locked_by: 'workerA',
        }] 
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE query

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/request-queues/queue-1/requests/req-1?clientKey=workerA',
      payload: { retryCount: 1 },
    });

    expect(response.statusCode).toBe(200);
  });

  it('should reject update when clientKey does not match lock owner', async () => {
    const futureDate = new Date(Date.now() + 60000);
    
    mockQuery.mockResolvedValueOnce({ 
      rows: [{ 
        id: 'req-1',
        queue_id: 'queue-1',
        unique_key: 'test-url',
        url: 'https://example.com',
        method: 'GET',
        retry_count: 0,
        no_retry: false,
        error_messages: null,
        headers: null,
        user_data: null,
        handled_at: null,
        order_no: 1,
        locked_until: futureDate,
        locked_by: 'workerA',
      }] 
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/request-queues/queue-1/requests/req-1?clientKey=workerB',
      payload: { retryCount: 1 },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.message).toContain('locked');
  });

  it('should allow update when request is not locked', async () => {
    mockQuery
      .mockResolvedValueOnce({ 
        rows: [{ 
          id: 'req-1',
          queue_id: 'queue-1',
          unique_key: 'test-url',
          url: 'https://example.com',
          method: 'GET',
          retry_count: 0,
          no_retry: false,
          error_messages: null,
          headers: null,
          user_data: null,
          handled_at: null,
          order_no: 1,
          locked_until: null, // not locked
          locked_by: null,
        }] 
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/request-queues/queue-1/requests/req-1',
      payload: { retryCount: 1 },
    });

    expect(response.statusCode).toBe(200);
  });

  it('should allow update when lock has expired', async () => {
    const pastDate = new Date(Date.now() - 60000); // expired 60 seconds ago
    
    mockQuery
      .mockResolvedValueOnce({ 
        rows: [{ 
          id: 'req-1',
          queue_id: 'queue-1',
          unique_key: 'test-url',
          url: 'https://example.com',
          method: 'GET',
          retry_count: 0,
          no_retry: false,
          error_messages: null,
          headers: null,
          user_data: null,
          handled_at: null,
          order_no: 1,
          locked_until: pastDate, // expired
          locked_by: 'workerA',
        }] 
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/v2/request-queues/queue-1/requests/req-1?clientKey=workerB',
      payload: { retryCount: 1 },
    });

    expect(response.statusCode).toBe(200);
  });
});
