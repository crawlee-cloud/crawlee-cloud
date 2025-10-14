/**
 * Actor Runs Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
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
    it('should list runs', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          createRunRow(),
          createRunRow({ id: 'run-2', status: 'SUCCEEDED' }),
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
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
});
