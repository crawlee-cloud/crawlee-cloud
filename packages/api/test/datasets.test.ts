/**
 * Dataset Routes Tests
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

import { datasetsRoutes } from '../src/routes/datasets.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockPutDatasetBatch = vi.fn();
const mockListDatasetItems = vi.fn();
const mockIterateDatasetItems = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putDatasetBatch: (...args: unknown[]) => mockPutDatasetBatch(...args),
  listDatasetItems: (...args: unknown[]) => mockListDatasetItems(...args),
  iterateDatasetItems: (...args: unknown[]) => mockIterateDatasetItems(...args),
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
    mockPutDatasetBatch.mockReset();
    mockListDatasetItems.mockReset();
    mockIterateDatasetItems.mockReset();
    delete process.env.DATASET_BATCH_SIZE;
  });

  describe('GET /v2/datasets', () => {
    it('should list datasets', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'ds-1',
            name: 'test-dataset',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            item_count: 10,
          },
          {
            id: 'ds-2',
            name: null,
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            item_count: 5,
          },
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
          rows: [
            {
              id: 'ds-1',
              name: 'test',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 10,
            },
          ],
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
        rows: [
          {
            id: 'ds-1',
            name: 'test',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            item_count: 100,
          },
        ],
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
    it('should push single item as a 1-item batch', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'ds-1',
              name: 'test',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 0,
            },
          ],
        })
        // UPDATE ... RETURNING item_count — atomic reservation returns the
        // new total. startCount = returned - items.length = 1 - 1 = 0.
        .mockResolvedValueOnce({ rows: [{ item_count: 1 }] });

      mockPutDatasetBatch.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/ds-1/items',
        payload: { url: 'https://example.com', title: 'Test' },
      });

      expect(response.statusCode).toBe(201);
      // One pushData call → one batch object, regardless of item count.
      expect(mockPutDatasetBatch).toHaveBeenCalledTimes(1);
      expect(mockPutDatasetBatch).toHaveBeenCalledWith('ds-1', 0, [
        { url: 'https://example.com', title: 'Test' },
      ]);
    });

    it('should push array of items as a single batch under default batch size', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'ds-1',
              name: 'test',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 0,
            },
          ],
        })
        // UPDATE ... RETURNING item_count: 0 + 3 = 3. startCount = 0.
        .mockResolvedValueOnce({ rows: [{ item_count: 3 }] });

      mockPutDatasetBatch.mockResolvedValue(undefined);

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
      // 3 items, default batch size 500 → 1 batch object.
      expect(mockPutDatasetBatch).toHaveBeenCalledTimes(1);
      expect(mockPutDatasetBatch).toHaveBeenCalledWith('ds-1', 0, [
        { url: 'https://example1.com' },
        { url: 'https://example2.com' },
        { url: 'https://example3.com' },
      ]);
    });

    it('should split large pushes per DATASET_BATCH_SIZE', async () => {
      process.env.DATASET_BATCH_SIZE = '500';

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'ds-1',
              name: 'test',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 100,
            },
          ],
        })
        // UPDATE ... RETURNING: existing 100 + 1500 added = 1600.
        // startCount = 1600 - 1500 = 100. Batch start indices: 100, 600, 1100.
        .mockResolvedValueOnce({ rows: [{ item_count: 1600 }] });

      mockPutDatasetBatch.mockResolvedValue(undefined);

      const items = Array.from({ length: 1500 }, (_, i) => ({ idx: i }));

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/ds-1/items',
        payload: items,
      });

      expect(response.statusCode).toBe(201);
      // 1500 items / 500 per batch = 3 batch objects.
      expect(mockPutDatasetBatch).toHaveBeenCalledTimes(3);
      // Start indices are absolute (offset by existing item_count = 100).
      expect(mockPutDatasetBatch.mock.calls[0]?.[1]).toBe(100);
      expect(mockPutDatasetBatch.mock.calls[1]?.[1]).toBe(600);
      expect(mockPutDatasetBatch.mock.calls[2]?.[1]).toBe(1100);
    });

    it('should auto-create dataset if not exists', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // dataset not found
        .mockResolvedValueOnce({ rows: [] }) // insert
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'new-ds',
              name: 'new-dataset',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 0,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ item_count: 1 }] }); // atomic reservation

      mockPutDatasetBatch.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/new-dataset/items',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should 404 if the dataset disappears between SELECT and atomic UPDATE', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'ds-vanish',
              name: 'vanish',
              user_id: null,
              created_at: new Date(),
              modified_at: new Date(),
              accessed_at: new Date(),
              item_count: 0,
            },
          ],
        })
        // UPDATE ... RETURNING returns no rows when WHERE id = $2 matches
        // nothing — e.g. dataset DELETE-d concurrently.
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/datasets/ds-vanish/items',
        payload: { data: 'test' },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('record-not-found');
      // No S3 write should have happened.
      expect(mockPutDatasetBatch).not.toHaveBeenCalled();
    });
  });

  describe('GET /v2/datasets/:datasetId/items — total from item_count', () => {
    it('should pass dataset.item_count as total to listDatasetItems', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'ds-1',
            name: 'test',
            user_id: null,
            created_at: new Date(),
            modified_at: new Date(),
            accessed_at: new Date(),
            item_count: 50000,
          },
        ],
      });
      mockListDatasetItems.mockResolvedValueOnce({
        items: [],
        total: 50000,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?offset=0&limit=10',
      });

      expect(response.statusCode).toBe(200);
      // Authoritative total comes from PG, not S3 listing — guards against
      // the legacy 1000-key cap regressing.
      expect(mockListDatasetItems).toHaveBeenCalledWith('ds-1', {
        offset: 0,
        limit: 10,
        total: 50000,
      });
      expect(response.headers['x-apify-pagination-total']).toBe('50000');
    });
  });
});
