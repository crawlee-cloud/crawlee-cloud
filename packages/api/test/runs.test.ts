/**
 * Actor Runs Routes Tests
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

import { runsRoutes } from '../src/routes/runs.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../src/storage/s3.js', () => ({
  listDatasetItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getKVRecord: vi.fn().mockResolvedValue(null),
}));

const createRunRow = (overrides = {}) => ({
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: null,
  status: 'RUNNING',
  status_message: null,
  started_at: new Date(),
  finished_at: null,
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'queue-1',
  timeout_secs: 3600,
  memory_mbytes: 1024,
  container_url: null,
  created_at: new Date(),
  modified_at: new Date(),
  ...overrides,
});

describe('Actor Runs Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(runsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /v2/actor-runs', () => {
    it('should list runs (with real total via COUNT)', async () => {
      // Route runs COUNT(*) and the page SELECT in parallel — mock both.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '2' }] }).mockResolvedValueOnce({
        rows: [createRunRow(), createRunRow({ id: 'run-2', status: 'SUCCEEDED' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
      expect(body.data.limit).toBe(50);
      expect(body.data.offset).toBe(0);
    });
  });

  describe('GET /v2/actor-runs/stats', () => {
    it('returns aggregate counts parsed from server-side COUNT FILTER', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            total: '5234',
            running: '12',
            succeeded: '4200',
            failed: '1022',
            failed_last_24h: '7',
          },
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual({
        total: 5234,
        running: 12,
        succeeded: 4200,
        failed: 1022,
        failedLast24h: 7,
      });
    });

    it('scopes to the authenticated user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '0', running: '0', succeeded: '0', failed: '0', failed_last_24h: '0' }],
      });

      await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['test-user-id']);
    });

    // Locks in the FAILED ∪ TIMED-OUT grouping so the dashboard tile can't
    // silently diverge from the histogram's FAIL caps. ABORTED must stay out
    // (operator-cancellation, not a failure).
    it("groups TIMED-OUT into 'failed' but excludes ABORTED", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '0', running: '0', succeeded: '0', failed: '0', failed_last_24h: '0' }],
      });

      await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("status IN ('FAILED', 'TIMED-OUT')");
      expect(sql).not.toContain("'ABORTED'");
    });
  });

  describe('GET /v2/actor-runs/histogram', () => {
    it('returns server-shaped buckets with total + failed parsed as numbers', async () => {
      const bucketA = new Date('2026-05-04T10:00:00Z');
      const bucketB = new Date('2026-05-04T11:00:00Z');
      mockQuery.mockResolvedValueOnce({
        rows: [
          { bucket: bucketA, total: '5', failed: '1' },
          { bucket: bucketB, total: '0', failed: '0' },
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.hours).toBe(24);
      expect(body.data.buckets).toEqual([
        { hour: bucketA.toISOString(), total: 5, failed: 1 },
        { hour: bucketB.toISOString(), total: 0, failed: 0 },
      ]);
    });

    it('passes through the user_id and the requested hours window to SQL', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=6' });

      expect(response.statusCode).toBe(200);
      // The route passes [userId, hours] as bind params; both must reach the DB.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['test-user-id', 6]);
    });

    it('rejects out-of-range hours', async () => {
      const tooBig = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=999' });
      expect(tooBig.statusCode).toBe(500); // Zod parse throws → Fastify 500 by default

      const zero = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=0' });
      expect(zero.statusCode).toBe(500);
    });
  });

  describe('GET /v2/actor-runs/:runId', () => {
    it('should get run by id', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow()],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/run-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('run-1');
      expect(body.data.status).toBe('RUNNING');
    });

    it('should return 404 for non-existent run', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /v2/actor-runs/:runId', () => {
    it('should update run status', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'SUCCEEDED', finished_at: new Date() })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/actor-runs/run-1',
        payload: { status: 'SUCCEEDED' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('SUCCEEDED');
    });

    it('should update status message', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status_message: 'Processing page 5/10' })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/actor-runs/run-1',
        payload: { statusMessage: 'Processing page 5/10' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /v2/actor-runs/:runId/abort', () => {
    it('should abort running actor', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'ABORTED', finished_at: new Date() })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/abort',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('ABORTED');
    });

    it('should return 404 if run not found or already finished', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/non-existent/abort',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /v2/actor-runs/:runId/resurrect', () => {
    it('should resurrect failed run', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'RUNNING', finished_at: null })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/resurrect',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('RUNNING');
    });
  });

  describe('GET /v2/actor-runs/:runId/dataset/items', () => {
    it('should get dataset items for run', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow()],
      });

      const { listDatasetItems } = await import('../src/storage/s3.js');
      (listDatasetItems as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        items: [{ url: 'https://example.com' }],
        total: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/run-1/dataset/items',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
    });
  });

  describe('POST /v2/actor-runs/:runId/ingest-crawler-stats', () => {
    // Locks the SDK file → stats_json normalization. Receivers reading
    // resource.stats from webhook payloads rely on the field names we
    // pick here.

    it('returns stats:null and does not UPDATE when SDK_CRAWLER_STATISTICS_0 is missing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
      });
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.stats).toBeNull();
      // Only one query ran (the run-lookup); the UPDATE didn't fire.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('parses SDK file and writes a normalized stats_json on UPDATE', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

      const sdkPayload = {
        requestsFinished: 42,
        requestsFailed: 3,
        requestsTotal: 45,
        requestsRetries: 7,
        crawlerRuntimeMillis: 38176,
        crawlerStartedAt: '2026-05-02T11:24:55.000Z',
        crawlerFinishedAt: '2026-05-02T11:25:33.000Z',
      };
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce({
        value: Buffer.from(JSON.stringify(sdkPayload), 'utf8'),
        contentType: 'application/json',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Apify-compat fields the existing webhook payload already promised
      expect(body.data.stats).toMatchObject({
        runTimeSecs: 38, // 38176 ms → 38 s
        computeUnits: 0,
        inputBodyLen: 0,
      });
      // Crawlee extension — receivers reading these get the rich picture
      expect(body.data.stats).toMatchObject({
        requestsFinished: 42,
        requestsFailed: 3,
        requestsTotal: 45,
        requestsRetries: 7,
        crawlerRuntimeMillis: 38176,
        crawlerStartedAt: '2026-05-02T11:24:55.000Z',
        crawlerFinishedAt: '2026-05-02T11:25:33.000Z',
      });
      // UPDATE was called with the normalized stats
      const updateCall = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateCall[0]).toMatch(/UPDATE runs SET stats_json/);
      expect((updateCall[1][0] as Record<string, number>).requestsFailed).toBe(3);
    });

    it('rejects malformed SDK JSON with 422 — does not silently corrupt stats_json', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
      });
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce({
        value: Buffer.from('not json{{{', 'utf8'),
        contentType: 'application/json',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('invalid-stats');
    });

    it('returns 404 when the run is not owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check fails

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/foreign/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
