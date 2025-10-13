/**
 * Actor Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { actorsRoutes } from '../src/routes/actors.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockRedisPublish = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: (...args: unknown[]) => mockRedisPublish(...args),
  },
}));

vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

const createActorRow = (overrides = {}) => ({
  id: 'actor-1',
  name: 'test-actor',
  user_id: null,
  title: 'Test Actor',
  description: 'A test actor',
  default_run_options: null,
  created_at: new Date(),
  modified_at: new Date(),
  ...overrides,
});

describe('Actor Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(actorsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRedisPublish.mockReset();
  });

  describe('GET /v2/acts', () => {
    it('should list actors', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createActorRow(), createActorRow({ id: 'actor-2', name: 'actor-2' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
    });
  });

  describe('POST /v2/acts', () => {
    it('should create new actor', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // no existing
        .mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'test-actor', title: 'Test Actor' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('test-actor');
    });

    it('should update existing actor', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createActorRow()] }) // existing
        .mockResolvedValueOnce({ rows: [createActorRow({ title: 'Updated Title' })] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts',
        payload: { name: 'test-actor', title: 'Updated Title' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /v2/acts/:actorId', () => {
    it('should get actor by id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createActorRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/actor-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('actor-1');
    });

    it('should return 404 for non-existent actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/acts/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /v2/acts/:actorId', () => {
    it('should update actor', async () => {
      mockQuery.mockResolvedValueOnce({ 
        rows: [createActorRow({ title: 'New Title' })] 
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/acts/actor-1',
        payload: { title: 'New Title' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('DELETE /v2/acts/:actorId', () => {
    it('should delete actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/acts/actor-1',
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('POST /v2/acts/:actorId/runs', () => {
    it('should start actor run', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [createActorRow()] }) // get actor
        .mockResolvedValueOnce({ rows: [] }) // dataset insert
        .mockResolvedValueOnce({ rows: [] }) // kv store insert
        .mockResolvedValueOnce({ rows: [] }) // queue insert
        .mockResolvedValueOnce({ 
          rows: [{ 
            id: 'run-1', 
            actor_id: 'actor-1', 
            status: 'READY',
            started_at: null,
            default_dataset_id: 'ds-1',
            default_key_value_store_id: 'kv-1',
            default_request_queue_id: 'rq-1',
            timeout_secs: 3600,
            memory_mbytes: 1024,
            created_at: new Date(),
          }] 
        });

      mockRedisPublish.mockResolvedValueOnce(1);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/actor-1/runs',
        payload: { input: { url: 'https://example.com' } },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('READY');
      expect(mockRedisPublish).toHaveBeenCalledWith('run:new', expect.any(String));
    });

    it('should return 404 for non-existent actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/acts/non-existent/runs',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
