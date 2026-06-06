/**
 * Key-Value Store Routes Tests
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

import { keyValueStoresRoutes } from '../src/routes/key-value-stores.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockPutKVRecord = vi.fn();
const mockGetKVRecord = vi.fn();
const mockDeleteKVRecord = vi.fn();
const mockListKVKeys = vi.fn();
const mockDeleteKVStoreS3Prefix = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: (...args: unknown[]) => mockPutKVRecord(...args),
  getKVRecord: (...args: unknown[]) => mockGetKVRecord(...args),
  deleteKVRecord: (...args: unknown[]) => mockDeleteKVRecord(...args),
  listKVKeys: (...args: unknown[]) => mockListKVKeys(...args),
  kvRecordExists: vi.fn(),
  presignKVRecord: vi.fn(),
  deleteKVStoreS3Prefix: (...args: unknown[]) => mockDeleteKVStoreS3Prefix(...args),
}));

describe('Key-Value Store Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(keyValueStoresRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockPutKVRecord.mockReset();
    mockGetKVRecord.mockReset();
    mockDeleteKVRecord.mockReset();
    mockListKVKeys.mockReset();
    mockDeleteKVStoreS3Prefix.mockReset();
    mockDeleteKVStoreS3Prefix.mockResolvedValue(undefined);
  });

  describe('GET /v2/key-value-stores', () => {
    it('should list stores with real total from COUNT(*)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }).mockResolvedValueOnce({
        rows: [
          {
            id: 'kv-1',
            name: 'store-1',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.total).toBe(1);
    });
  });

  describe('GET /v2/key-value-stores/:storeId', () => {
    it('should get store by id', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'kv-1',
              name: 'store-1',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/kv-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('kv-1');
    });

    it('should return 404 for non-existent store', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v2/key-value-stores/:storeId/keys', () => {
    it('should list keys', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'kv-1',
            name: 'store-1',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          },
        ],
      });
      mockListKVKeys.mockResolvedValueOnce({
        keys: [
          { key: 'INPUT', size: 100 },
          { key: 'OUTPUT', size: 200 },
        ],
        isTruncated: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/kv-1/keys',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
    });
  });

  describe('GET /v2/key-value-stores/:storeId/records/:key', () => {
    it('should get record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'kv-1',
            name: 'store-1',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          },
        ],
      });
      mockGetKVRecord.mockResolvedValueOnce({
        value: JSON.stringify({ startUrls: ['https://example.com'] }),
        contentType: 'application/json',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/kv-1/records/INPUT',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
    });

    it('should return 404 with record-not-found for a missing record', async () => {
      // Apify SDK contract: apify-client's catchNotFoundOrThrow only fires
      // for 404 + error.type='record-not-found'. A 204 is treated as a
      // successful empty response and yields a truthy stub instead of
      // undefined, which breaks Crawlee's getValue / Actor.getInput paths.
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'kv-1',
            name: 'store-1',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          },
        ],
      });
      mockGetKVRecord.mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/kv-1/records/MISSING',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error?.type).toBe('record-not-found');
    });
  });

  describe('PUT /v2/key-value-stores/:storeId/records/:key', () => {
    it('should set record', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'kv-1',
              name: 'store-1',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });
      mockPutKVRecord.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/key-value-stores/kv-1/records/OUTPUT',
        payload: { result: 'test' },
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBe(201);
      expect(mockPutKVRecord).toHaveBeenCalled();
    });
  });

  describe('DELETE /v2/key-value-stores/:storeId (store-level)', () => {
    it('deletes the PG row AND cleans up the S3 prefix (no silent storage leak)', async () => {
      // Symmetric with the dataset DELETE fix: pre-v1.0 the handler
      // only removed the PG row, leaving KV value blobs (potentially
      // large — KV stores hold serialized run state and arbitrary
      // operator-pushed data) orphaned in S3.
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'kv-1' }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/key-value-stores/my-store-by-name',
      });

      expect(response.statusCode).toBe(204);
      expect(mockDeleteKVStoreS3Prefix).toHaveBeenCalledTimes(1);
      expect(mockDeleteKVStoreS3Prefix).toHaveBeenCalledWith('kv-1');
    });

    it('returns 404 without invoking S3 cleanup when the store does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/key-value-stores/does-not-exist',
      });

      expect(response.statusCode).toBe(404);
      expect(mockDeleteKVStoreS3Prefix).not.toHaveBeenCalled();
    });

    it('still returns 204 when S3 cleanup fails — PG is the source of truth', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'kv-2' }] });
      mockDeleteKVStoreS3Prefix.mockRejectedValueOnce(new Error('S3 unreachable'));

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/key-value-stores/kv-2',
      });

      expect(response.statusCode).toBe(204);
      expect(mockDeleteKVStoreS3Prefix).toHaveBeenCalledWith('kv-2');
    });
  });

  describe('DELETE /v2/key-value-stores/:storeId/records/:key', () => {
    it('should delete record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'kv-1',
            name: 'store-1',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
          },
        ],
      });
      mockDeleteKVRecord.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/key-value-stores/kv-1/records/OLD_KEY',
      });

      expect(response.statusCode).toBe(204);
    });
  });
});
