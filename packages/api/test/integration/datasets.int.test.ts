import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('Datasets (integration)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const user = await createTestUser();
    token = user.token;
  });

  afterEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    token = user.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a dataset, pushes items, and retrieves them', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/v2/datasets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'test-ds' },
    });
    expect(create.statusCode).toBe(201);
    const datasetId = create.json().data.id;

    // Push items
    const push = await app.inject({
      method: 'POST',
      url: `/v2/datasets/${datasetId}/items`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    });
    expect(push.statusCode).toBe(201);

    // Get items
    const items = await app.inject({
      method: 'GET',
      url: `/v2/datasets/${datasetId}/items`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toHaveLength(3);
    expect(items.json()[0]).toEqual({ title: 'A' });
  });

  it('respects pagination offset and limit', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v2/datasets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'paged' },
    });
    const id = create.json().data.id;

    // Push 5 items
    await app.inject({
      method: 'POST',
      url: `/v2/datasets/${id}/items`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
    });

    const page = await app.inject({
      method: 'GET',
      url: `/v2/datasets/${id}/items?offset=2&limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toHaveLength(2);
    expect(page.json()[0]).toEqual({ n: 3 });
  });

  it('isolates datasets between users (IDOR)', async () => {
    // User A creates a dataset
    await app.inject({
      method: 'POST',
      url: '/v2/datasets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'private-ds' },
    });

    // User B
    const userB = await createTestUser('userb@test.local', 'password123');

    const list = await app.inject({
      method: 'GET',
      url: '/v2/datasets',
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(list.json().data.items).toHaveLength(0);
  });
  describe('item projection and ordering (fields / omit / desc)', () => {
    const auth = () => ({ authorization: `Bearer ${token}` });
    const row = (n: number) => ({ rank: n, title: `t${n}`, price: n * 10 });

    /**
     * Push items 1..5 in three pushes so they span three S3 batch objects
     * ([1,2], [3,4], [5]) — desc must reverse across batch boundaries,
     * not just within one.
     */
    async function seed(push: (items: unknown[]) => Promise<void>) {
      await push([row(1), row(2)]);
      await push([row(3), row(4)]);
      await push([row(5)]);
    }

    async function seededDataset(): Promise<string> {
      const create = await app.inject({
        method: 'POST',
        url: '/v2/datasets',
        headers: auth(),
        payload: { name: 'projection' },
      });
      const id = create.json().data.id;
      await seed(async (items) => {
        const res = await app.inject({
          method: 'POST',
          url: `/v2/datasets/${id}/items`,
          headers: auth(),
          payload: items,
        });
        expect(res.statusCode).toBe(201);
      });
      return id;
    }

    const get = (url: string) => app.inject({ method: 'GET', url, headers: auth() });

    it('?fields=title returns only title on all three branches', async () => {
      const id = await seededDataset();
      const titles = [1, 2, 3, 4, 5].map((n) => ({ title: `t${n}` }));

      expect((await get(`/v2/datasets/${id}/items?fields=title`)).json()).toEqual(titles);
      expect((await get(`/v2/datasets/${id}/items?limit=10&fields=title`)).json()).toEqual(titles);
      expect((await get(`/v2/datasets/${id}/items?download=1&fields=title`)).json()).toEqual(
        titles
      );
    });

    it('?omit=price drops price; empty fields/omit/flatten return full items', async () => {
      const id = await seededDataset();

      expect((await get(`/v2/datasets/${id}/items?limit=1&omit=price`)).json()).toEqual([
        { rank: 1, title: 't1' },
      ]);
      expect((await get(`/v2/datasets/${id}/items?limit=1&fields=&omit=&flatten=`)).json()).toEqual(
        [row(1)]
      );
    });

    it('?desc=1&limit=2 returns the last two items newest first, across batches', async () => {
      const id = await seededDataset();

      const page = await get(`/v2/datasets/${id}/items?desc=1&limit=2`);
      expect(page.json()).toEqual([row(5), row(4)]);
      expect(page.headers['x-apify-pagination-total']).toBe('5');
      expect(page.headers['x-apify-pagination-offset']).toBe('0');
      expect(page.headers['x-apify-pagination-limit']).toBe('2');

      // offset counts from the end
      expect((await get(`/v2/datasets/${id}/items?desc=1&offset=2&limit=2`)).json()).toEqual([
        row(3),
        row(2),
      ]);
      // streaming branch (no limit) and download reverse the whole dataset
      expect((await get(`/v2/datasets/${id}/items?desc=true&offset=1`)).json()).toEqual([
        row(4),
        row(3),
        row(2),
        row(1),
      ]);
      expect((await get(`/v2/datasets/${id}/items?desc=1&download=1&fields=rank`)).json()).toEqual(
        [5, 4, 3, 2, 1].map((rank) => ({ rank }))
      );
    });

    it('run-scoped items: same projection/desc, and the authoritative pagination total', async () => {
      const actor = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        headers: auth(),
        payload: { name: 'items-actor' },
      });
      const run = await app.inject({
        method: 'POST',
        url: `/v2/acts/${actor.json().data.id}/runs`,
        headers: auth(),
      });
      const runId = run.json().data.id;
      const datasetId = run.json().data.defaultDatasetId;
      await seed(async (items) => {
        const res = await app.inject({
          method: 'POST',
          url: `/v2/datasets/${datasetId}/items`,
          headers: auth(),
          payload: items,
        });
        expect(res.statusCode).toBe(201);
      });

      const base = `/v2/actor-runs/${runId}/dataset/items`;
      // (The missing-total regression is pinned by the next test, whose
      // last batch holds more than one item.)
      const page = await get(`${base}?limit=10&fields=title`);
      expect(page.headers['x-apify-pagination-total']).toBe('5');
      expect(page.json()).toEqual([1, 2, 3, 4, 5].map((n) => ({ title: `t${n}` })));

      expect((await get(`${base}?desc=1&limit=2&omit=price`)).json()).toEqual([
        { rank: 5, title: 't5' },
        { rank: 4, title: 't4' },
      ]);
    });

    it('run-scoped items: offsets past the last batch start still return its tail', async () => {
      const actor = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        headers: auth(),
        payload: { name: 'tail-actor' },
      });
      const run = await app.inject({
        method: 'POST',
        url: `/v2/acts/${actor.json().data.id}/runs`,
        headers: auth(),
      });
      const runId = run.json().data.id;
      const datasetId = run.json().data.defaultDatasetId;
      // One batch of 4 items starting at index 0.
      await app.inject({
        method: 'POST',
        url: `/v2/datasets/${datasetId}/items`,
        headers: auth(),
        payload: [row(1), row(2), row(3), row(4)],
      });

      // Pre-fix, listDatasetItems got no total and sized the last batch
      // as 1 item: total read 1 and offset 2 returned [].
      const page = await get(`/v2/actor-runs/${runId}/dataset/items?offset=2&limit=10`);
      expect(page.headers['x-apify-pagination-total']).toBe('4');
      expect(page.json()).toEqual([row(3), row(4)]);
    });
  });
});
