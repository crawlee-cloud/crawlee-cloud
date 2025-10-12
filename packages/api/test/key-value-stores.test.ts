/**
 * Key-Value Store Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { keyValueStoresRoutes } from '../src/routes/key-value-stores.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockPutKVRecord = vi.fn();
const mockGetKVRecord = vi.fn();
const mockDeleteKVRecord = vi.fn();
const mockListKVKeys = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: (...args: unknown[]) => mockPutKVRecord(...args),
  getKVRecord: (...args: unknown[]) => mockGetKVRecord(...args),
  deleteKVRecord: (...args: unknown[]) => mockDeleteKVRecord(...args),
  listKVKeys: (...args: unknown[]) => mockListKVKeys(...args),
  kvRecordExists: vi.fn(),
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
  });

  describe('GET /v2/key-value-stores', () => {
    it('should list stores', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(1);
    });
  });

  describe('GET /v2/key-value-stores/:storeId', () => {
    it('should get store by id', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
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
        rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
      });
      mockListKVKeys.mockResolvedValueOnce({
        keys: [{ key: 'INPUT', size: 100 }, { key: 'OUTPUT', size: 200 }],
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
        rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
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

    it('should return 204 for missing record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
      });
      mockGetKVRecord.mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/key-value-stores/kv-1/records/MISSING',
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('PUT /v2/key-value-stores/:storeId/records/:key', () => {
    it('should set record', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
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

  describe('DELETE /v2/key-value-stores/:storeId/records/:key', () => {
    it('should delete record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'kv-1', name: 'store-1', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date() }],
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
