/**
 * Dataset Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { datasetsRoutes } from '../src/routes/datasets.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockPutDatasetItem = vi.fn();
const mockListDatasetItems = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putDatasetItem: (...args: unknown[]) => mockPutDatasetItem(...args),
  listDatasetItems: (...args: unknown[]) => mockListDatasetItems(...args),
}));

describe('Dataset Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(datasetsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockPutDatasetItem.mockReset();
    mockListDatasetItems.mockReset();
  });

  describe('GET /v2/datasets', () => {
    it('should list datasets', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'ds-1', name: 'test-dataset', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 10 },
          { id: 'ds-2', name: null, user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 5 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });
  });

  describe('GET /v2/datasets/:datasetId', () => {
    it('should get dataset by id', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'ds-1', name: 'test', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 10 }],
        })
        .mockResolvedValueOnce({ rows: [] }); // accessed_at update

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('ds-1');
    });

    it('should return 404 for non-existent dataset', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v2/datasets/:datasetId', () => {
    it('should delete dataset', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/datasets/ds-1',
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('GET /v2/datasets/:datasetId/items', () => {
    it('should list dataset items with pagination', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ds-1', name: 'test', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 100 }],
      });
      mockListDatasetItems.mockResolvedValueOnce({
        items: [{ url: 'https://example.com', title: 'Test' }],
        total: 100,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?offset=0&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(response.headers['x-apify-pagination-total']).toBe('100');
    });
  });

  describe('POST /v2/datasets/:datasetId/items', () => {
    it('should push single item', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'ds-1', name: 'test', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 0 }],
        })
        .mockResolvedValueOnce({ rows: [] }); // count update

      mockPutDatasetItem.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/ds-1/items',
        payload: { url: 'https://example.com', title: 'Test' },
      });

      expect(response.statusCode).toBe(201);
      expect(mockPutDatasetItem).toHaveBeenCalledTimes(1);
    });

    it('should push array of items', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'ds-1', name: 'test', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 0 }],
        })
        .mockResolvedValueOnce({ rows: [] });

      mockPutDatasetItem.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/ds-1/items',
        payload: [
          { url: 'https://example1.com' },
          { url: 'https://example2.com' },
          { url: 'https://example3.com' },
        ],
      });

      expect(response.statusCode).toBe(201);
      expect(mockPutDatasetItem).toHaveBeenCalledTimes(3);
    });

    it('should auto-create dataset if not exists', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // dataset not found
        .mockResolvedValueOnce({ rows: [] }) // insert
        .mockResolvedValueOnce({
          rows: [{ id: 'new-ds', name: 'new-dataset', user_id: null, created_at: new Date(), modified_at: new Date(), accessed_at: new Date(), item_count: 0 }],
        })
        .mockResolvedValueOnce({ rows: [] }); // count update

      mockPutDatasetItem.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/new-dataset/items',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(201);
    });
  });
});
