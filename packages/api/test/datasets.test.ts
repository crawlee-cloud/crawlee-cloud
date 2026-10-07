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
const mockDeleteDatasetS3Prefix = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  putDatasetBatch: (...args: unknown[]) => mockPutDatasetBatch(...args),
  listDatasetItems: (...args: unknown[]) => mockListDatasetItems(...args),
  iterateDatasetItems: (...args: unknown[]) => mockIterateDatasetItems(...args),
  deleteDatasetS3Prefix: (...args: unknown[]) => mockDeleteDatasetS3Prefix(...args),
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
    mockDeleteDatasetS3Prefix.mockReset();
    mockDeleteDatasetS3Prefix.mockResolvedValue(undefined);
    delete process.env.DATASET_BATCH_SIZE;
  });

  describe('GET /v2/datasets', () => {
    it('should list datasets with real total from COUNT(*)', async () => {
      // Two parallel queries: COUNT then page. Promise.all calls them in
      // array order so the mock queue must answer COUNT first.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '2' }] }).mockResolvedValueOnce({
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
      expect(body.data.count).toBe(2);
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
    it('deletes the PG row AND cleans up the S3 prefix (no silent storage leak)', async () => {
      // Pre-fix, this DELETE only ran the PG statement — the S3 items
      // (potentially gigabytes of scraped data) were left orphaned with
      // no tombstone for the retention reaper to pick up. Operators saw
      // the dataset disappear from the dashboard and reasonably assumed
      // the storage bill stopped growing. It didn't.
      //
      // Asserts both the rowCount path AND that the S3 cleanup helper
      // was invoked with the canonical PG id (the lookup accepts name
      // too, so we have to use the id returned by RETURNING, not the
      // path param).
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'ds-1' }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/datasets/my-dataset-by-name',
      });

      expect(response.statusCode).toBe(204);
      expect(mockDeleteDatasetS3Prefix).toHaveBeenCalledTimes(1);
      expect(mockDeleteDatasetS3Prefix).toHaveBeenCalledWith('ds-1');
    });

    it('returns 404 without invoking S3 cleanup when the dataset does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/datasets/does-not-exist',
      });

      expect(response.statusCode).toBe(404);
      expect(mockDeleteDatasetS3Prefix).not.toHaveBeenCalled();
    });

    it('still returns 204 when S3 cleanup fails — PG is the source of truth', async () => {
      // Operator-visible state: the PG row is gone, the dataset is no
      // longer in their list. An S3-side network blip means orphaned
      // bytes (cleanable by lifecycle policy later) — not worth
      // surfacing as a 500 that would confuse the operator into
      // thinking the delete didn't happen.
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'ds-2' }] });
      mockDeleteDatasetS3Prefix.mockRejectedValueOnce(new Error('S3 unreachable'));

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/datasets/ds-2',
      });

      expect(response.statusCode).toBe(204);
      expect(mockDeleteDatasetS3Prefix).toHaveBeenCalledWith('ds-2');
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

  describe('GET /v2/datasets/:datasetId/items — no limit ⇒ full dataset (Apify parity)', () => {
    const datasetRow = (itemCount: number) => ({
      rows: [
        {
          id: 'ds-1',
          name: 'test',
          user_id: null,
          created_at: new Date(),
          modified_at: new Date(),
          accessed_at: new Date(),
          item_count: itemCount,
        },
      ],
    });

    const items = (count: number) => Array.from({ length: count }, (_, i) => ({ n: i }));

    const yieldAll = (all: Array<Record<string, unknown>>) =>
      mockIterateDatasetItems.mockImplementationOnce(async function* () {
        for (const item of all) yield item;
      });

    it('should stream ALL items when limit is omitted — real Apify has no implicit page size', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(150));
      yieldAll(items(150));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(150);
      expect(response.headers['x-apify-pagination-total']).toBe('150');
      expect(response.headers['x-apify-pagination-offset']).toBe('0');
      expect(response.headers['x-apify-pagination-limit']).toBe('150');
      expect(response.headers['content-type']).toContain('application/json');
      // Plain JSON response, not a file download
      expect(response.headers['content-disposition']).toBeUndefined();
      // The paged path must not have been touched
      expect(mockListDatasetItems).not.toHaveBeenCalled();
    });

    it('should honor offset while streaming the remainder when limit is omitted', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(150));
      yieldAll(items(150));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?offset=50',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(100);
      expect(body[0]).toEqual({ n: 50 });
      expect(response.headers['x-apify-pagination-offset']).toBe('50');
      expect(response.headers['x-apify-pagination-limit']).toBe('100');
    });

    it('should keep the paged path byte-for-byte when limit IS provided', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(150));
      mockListDatasetItems.mockResolvedValueOnce({
        items: items(10),
        total: 150,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?offset=0&limit=10',
      });

      expect(response.statusCode).toBe(200);
      expect(mockListDatasetItems).toHaveBeenCalledWith('ds-1', {
        offset: 0,
        limit: 10,
        total: 150,
      });
      expect(mockIterateDatasetItems).not.toHaveBeenCalled();
      expect(response.headers['x-apify-pagination-limit']).toBe('10');
    });

    it('should return an empty array for an empty dataset when limit is omitted', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(0));
      yieldAll([]);

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
      expect(response.headers['x-apify-pagination-total']).toBe('0');
      expect(response.headers['x-apify-pagination-limit']).toBe('0');
    });

    it('should keep download=1 as an attachment download', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      yieldAll(items(2));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?download=1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(JSON.parse(response.body)).toHaveLength(2);
    });
  });
  describe('GET /v2/datasets/:datasetId/items — fields / omit / desc (Apify parity)', () => {
    const datasetRow = (itemCount: number) => ({
      rows: [
        {
          id: 'ds-1',
          name: 'test',
          user_id: null,
          created_at: new Date(),
          modified_at: new Date(),
          accessed_at: new Date(),
          item_count: itemCount,
        },
      ],
    });
    const row = (i: number) => ({ rank: i, title: `t${i}`, price: i * 10 });
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => row(from + i));
    const yieldAll = (all: unknown[]) =>
      mockIterateDatasetItems.mockImplementationOnce(async function* () {
        for (const item of all) yield item;
      });

    it('?fields=title keeps only title on the paginated branch', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(3));
      mockListDatasetItems.mockResolvedValueOnce({ items: rows(0, 3), total: 3 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=10&fields=title',
      });

      expect(JSON.parse(response.body)).toEqual([
        { title: 't0' },
        { title: 't1' },
        { title: 't2' },
      ]);
    });

    it('?fields=title keeps only title on the streaming (no limit) branch', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      yieldAll(rows(0, 2));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?fields=title',
      });

      expect(JSON.parse(response.body)).toEqual([{ title: 't0' }, { title: 't1' }]);
    });

    it('?fields=title keeps only title on the download branch', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      yieldAll(rows(0, 2));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?download=1&fields=title',
      });

      expect(response.headers['content-disposition']).toContain('attachment');
      expect(JSON.parse(response.body)).toEqual([{ title: 't0' }, { title: 't1' }]);
    });

    it('?fields=price,rank returns keys in the requested order and skips missing ones', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(1));
      mockListDatasetItems.mockResolvedValueOnce({ items: [row(1)], total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=1&fields=price,nope,rank',
      });

      const [item] = JSON.parse(response.body);
      expect(Object.keys(item)).toEqual(['price', 'rank']);
    });

    it('?omit=price drops price', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(1));
      mockListDatasetItems.mockResolvedValueOnce({ items: [row(1)], total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=1&omit=price',
      });

      expect(JSON.parse(response.body)).toEqual([{ rank: 1, title: 't1' }]);
    });

    it('applies omit after fields', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(1));
      mockListDatasetItems.mockResolvedValueOnce({ items: [row(1)], total: 1 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=1&fields=title,price&omit=price',
      });

      expect(JSON.parse(response.body)).toEqual([{ title: 't1' }]);
    });

    it('?fields=&omit=&flatten= (apify-client / MCP empty arrays) returns full items', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      mockListDatasetItems.mockResolvedValueOnce({ items: rows(0, 2), total: 2 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=2&fields=&omit=&flatten=',
      });

      expect(JSON.parse(response.body)).toEqual(rows(0, 2));
    });

    it('passes non-object items through projection untouched', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      mockListDatasetItems.mockResolvedValueOnce({ items: ['plain', null], total: 2 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?limit=2&fields=title',
      });

      expect(JSON.parse(response.body)).toEqual(['plain', null]);
    });

    it('?desc=1&limit=2 reads the last two items and returns them newest first', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(5));
      mockListDatasetItems.mockResolvedValueOnce({ items: rows(3, 5), total: 5 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?desc=1&limit=2',
      });

      expect(mockListDatasetItems).toHaveBeenCalledWith('ds-1', { offset: 3, limit: 2, total: 5 });
      expect(JSON.parse(response.body)).toEqual([row(4), row(3)]);
      // Headers keep their meaning: the requested offset / limit.
      expect(response.headers['x-apify-pagination-total']).toBe('5');
      expect(response.headers['x-apify-pagination-offset']).toBe('0');
      expect(response.headers['x-apify-pagination-limit']).toBe('2');
    });

    it('desc offset counts from the end, and the first page clamps at item 0', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(5));
      mockListDatasetItems.mockResolvedValueOnce({ items: rows(0, 1), total: 5 });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?desc=true&offset=4&limit=3',
      });

      // Window [5 - 4 - 3, 5 - 4) = [-2, 1) → clamped to [0, 1).
      expect(mockListDatasetItems).toHaveBeenCalledWith('ds-1', { offset: 0, limit: 1, total: 5 });
      expect(JSON.parse(response.body)).toEqual([row(0)]);
    });

    it('desc offset past the end returns [] without reading S3', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(5));

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?desc=1&offset=5&limit=3',
      });

      expect(JSON.parse(response.body)).toEqual([]);
      expect(mockListDatasetItems).not.toHaveBeenCalled();
      expect(response.headers['x-apify-pagination-total']).toBe('5');
    });

    it('desc on the streaming branch iterates in reverse and skips offset from the end', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(4));
      // The mock stands in for iterateDatasetItems(…, { reverse: true }).
      yieldAll(rows(0, 4).reverse());

      const response = await app.inject({
        method: 'GET',
        url: '/v2/datasets/ds-1/items?desc=1&offset=1',
      });

      expect(mockIterateDatasetItems).toHaveBeenCalledWith('ds-1', { reverse: true });
      expect(JSON.parse(response.body)).toEqual([row(2), row(1), row(0)]);
      expect(response.headers['x-apify-pagination-limit']).toBe('3');
    });

    it('treats desc values other than 1/true as ascending', async () => {
      mockQuery.mockResolvedValueOnce(datasetRow(2));
      yieldAll(rows(0, 2));

      await app.inject({ method: 'GET', url: '/v2/datasets/ds-1/items?desc=0' });

      expect(mockIterateDatasetItems).toHaveBeenCalledWith('ds-1', { reverse: false });
    });
  });
});
