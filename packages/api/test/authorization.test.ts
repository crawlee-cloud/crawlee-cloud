/**
 * Authorization Tests
 *
 * Tests that users can only access their own resources (IDOR protection).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

// User A - the "owner" of resources
const USER_A = { id: 'user-a-id', email: 'user-a@example.com', role: 'user' };
// User B - should NOT be able to access User A's resources
const USER_B = { id: 'user-b-id', email: 'user-b@example.com', role: 'user' };

// Track which user is "logged in" for each request
let currentUser = USER_A;

// Mock authenticate middleware to use currentUser
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { ...currentUser };
  },
}));

// Import routes AFTER mocking
import { actorsRoutes } from '../src/routes/actors.js';
import { datasetsRoutes } from '../src/routes/datasets.js';
import { keyValueStoresRoutes } from '../src/routes/key-value-stores.js';
import { requestQueuesRoutes } from '../src/routes/request-queues.js';
import { runsRoutes } from '../src/routes/runs.js';

// Mock database
const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock Redis
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: vi.fn(),
    set: vi.fn(),
  },
  addToQueueHead: vi.fn(),
  lockRequest: vi.fn().mockResolvedValue(true),
}));

// Mock S3
vi.mock('../src/storage/s3.js', () => ({
  putKVRecord: vi.fn(),
  getKVRecord: vi.fn(),
  listDatasetItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}));

describe('Authorization Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await actorsRoutes(app);
    await datasetsRoutes(app);
    await keyValueStoresRoutes(app);
    await requestQueuesRoutes(app);
    await runsRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    currentUser = USER_A; // Reset to User A
  });

  describe('Actors - User Isolation', () => {
    it('should only list actors owned by the current user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'actor-1', name: 'my-actor', user_id: USER_A.id, title: 'My Actor' }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/acts',
      });

      expect(response.statusCode).toBe(200);

      // Verify query includes user_id filter
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), [USER_A.id]);
    });

    it("should return 404 when accessing another user's actor", async () => {
      // Actor exists but belongs to User A
      mockQuery.mockResolvedValueOnce({ rows: [] }); // No actor found for User B

      currentUser = USER_B;

      const response = await app.inject({
        method: 'GET',
        url: '/acts/actor-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });

    it("should create actor with current user's ID", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // No existing actor
        .mockResolvedValueOnce({
          rows: [{ id: 'new-actor', name: 'test', user_id: USER_A.id }],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/acts',
        payload: { name: 'test-actor' },
      });

      expect(response.statusCode).toBe(201);

      // Verify INSERT includes user_id
      const insertCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1]).toContain(USER_A.id);
    });

    it("should not allow User B to delete User A's actor", async () => {
      // DELETE returns no rows because actor doesn't belong to User B
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'DELETE',
        url: '/acts/actor-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);

      // Verify DELETE includes user_id filter
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('user_id = $2'),
        expect.arrayContaining([USER_B.id])
      );
    });
  });

  describe('Datasets - User Isolation', () => {
    it('should only list datasets owned by the current user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ds-1', name: 'my-dataset', user_id: USER_A.id }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/datasets',
      });

      expect(response.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), [USER_A.id]);
    });

    it("should return 404 when User B accesses User A's dataset", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'GET',
        url: '/datasets/dataset-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });

    it("should create dataset with current user's ID", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // No existing
        .mockResolvedValueOnce({
          rows: [{ id: 'new-ds', name: 'test', user_id: USER_A.id }],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/datasets',
        payload: { name: 'test-dataset' },
      });

      expect(response.statusCode).toBe(201);

      const insertCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1]).toContain(USER_A.id);
    });
  });

  describe('Key-Value Stores - User Isolation', () => {
    it('should only list KV stores owned by the current user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'kv-1', name: 'my-store', user_id: USER_A.id }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/key-value-stores',
      });

      expect(response.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), [USER_A.id]);
    });

    it("should return 404 when User B accesses User A's KV store", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'GET',
        url: '/key-value-stores/store-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Request Queues - User Isolation', () => {
    it('should only list queues owned by the current user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'q-1', name: 'my-queue', user_id: USER_A.id }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/request-queues',
      });

      expect(response.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), [USER_A.id]);
    });

    it("should return 404 when User B accesses User A's queue", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'GET',
        url: '/request-queues/queue-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });

    it("should not allow User B to delete User A's queue", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'DELETE',
        url: '/request-queues/queue-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Runs - User Isolation', () => {
    it('should only list runs owned by the current user', async () => {
      // GET /actor-runs runs COUNT + SELECT in parallel; mock both.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }).mockResolvedValueOnce({
        rows: [{ id: 'run-1', actor_id: 'act-1', user_id: USER_A.id, status: 'SUCCEEDED' }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs',
      });

      expect(response.statusCode).toBe(200);
      // Authorization check: every list query must scope by user_id.
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('user_id = $1'),
        expect.arrayContaining([USER_A.id])
      );
    });

    it("should return 404 when User B accesses User A's run", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/run-owned-by-user-a',
      });

      expect(response.statusCode).toBe(404);
    });

    it("should not allow User B to abort User A's run", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      currentUser = USER_B;

      const response = await app.inject({
        method: 'POST',
        url: '/actor-runs/run-owned-by-user-a/abort',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Cross-resource Authorization', () => {
    it('should create run with user-owned storages', async () => {
      // Mock actor lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'actor-1', name: 'test', user_id: USER_A.id }],
      });
      // Mock storage creation (3 INSERTs)
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Build lookup: actor has no SUCCEEDED build → null buildId/buildNumber.
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Mock run creation
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'run-1',
            actor_id: 'actor-1',
            status: 'READY',
            default_dataset_id: 'ds-1',
            default_key_value_store_id: 'kv-1',
            default_request_queue_id: 'q-1',
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/acts/actor-1/runs',
        payload: {},
      });

      expect(response.statusCode).toBe(201);

      // Verify all INSERT calls include user_id
      const insertCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );

      // Should have 4 INSERTs: dataset, kv store, queue, run
      expect(insertCalls.length).toBe(4);

      // Each should include user_id
      insertCalls.forEach((call) => {
        expect(call[1]).toContain(USER_A.id);
      });
    });
  });
});
