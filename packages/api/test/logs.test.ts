/**
 * Logs Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

const TEST_USER = { id: 'test-user-id', email: 'test@example.com', role: 'user' };

// Mock authenticate middleware
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { ...TEST_USER };
  },
}));

import { logsRoutes } from '../src/routes/logs.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    rpush: vi.fn(),
    ltrim: vi.fn(),
    publish: vi.fn(),
    lrange: vi.fn(),
    llen: vi.fn(),
  },
}));

// Import the mocked redis after vi.mock to get access to the mock functions
import { redis } from '../src/storage/redis.js';

describe('Logs Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await logsRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(redis.rpush).mockReset();
    vi.mocked(redis.ltrim).mockReset();
    vi.mocked(redis.publish).mockReset();
    vi.mocked(redis.lrange).mockReset();
    vi.mocked(redis.llen).mockReset();
  });

  describe('POST /actor-runs/:runId/logs', () => {
    it('should append log entry for owned run', async () => {
      // Run exists and belongs to user
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      vi.mocked(redis.rpush).mockResolvedValue(1);
      vi.mocked(redis.ltrim).mockResolvedValue('OK');
      vi.mocked(redis.publish).mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/actor-runs/run-1/logs',
        payload: {
          message: 'Test log message',
          level: 'INFO',
        },
      });

      expect(response.statusCode).toBe(201);

      // Verify ownership check
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_id = $2'), [
        'run-1',
        TEST_USER.id,
      ]);

      // Verify log was stored
      expect(redis.rpush).toHaveBeenCalledWith(
        'logs:run-1',
        expect.stringContaining('Test log message')
      );
    });

    it('should return 404 for run owned by another user', async () => {
      // Run not found (doesn't belong to current user)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/actor-runs/other-users-run/logs',
        payload: {
          message: 'Trying to write logs',
        },
      });

      expect(response.statusCode).toBe(404);
      expect(redis.rpush).not.toHaveBeenCalled();
    });

    it('should use default values for optional fields', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      vi.mocked(redis.rpush).mockResolvedValue(1);
      vi.mocked(redis.ltrim).mockResolvedValue('OK');
      vi.mocked(redis.publish).mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/actor-runs/run-1/logs',
        payload: {
          message: 'Log without level',
        },
      });

      expect(response.statusCode).toBe(201);

      // Verify default level is INFO
      const logCall = vi.mocked(redis.rpush).mock.calls[0];
      const logEntry = JSON.parse(logCall[1] as string);
      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe('Log without level');
      expect(logEntry.timestamp).toBeDefined();
    });
  });

  describe('GET /actor-runs/:runId/logs', () => {
    it('should get logs for owned run', async () => {
      // Run exists and belongs to user
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      // total of 2 lines stored — both fit in the default page
      vi.mocked(redis.llen).mockResolvedValue(2);
      vi.mocked(redis.lrange).mockResolvedValue([
        JSON.stringify({ timestamp: '2024-01-01T00:00:00Z', level: 'INFO', message: 'Log 1' }),
        JSON.stringify({ timestamp: '2024-01-01T00:00:01Z', level: 'INFO', message: 'Log 2' }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/run-1/logs',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items[0].message).toBe('Log 1');
      expect(body.data.total).toBe(2);
    });

    it('should return 404 for run owned by another user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/other-users-run/logs',
      });

      expect(response.statusCode).toBe(404);
      expect(redis.lrange).not.toHaveBeenCalled();
      expect(redis.llen).not.toHaveBeenCalled();
    });

    it('should support pagination parameters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      // 100 stored lines so the requested offset=10,limit=50 page (rows 10-59)
      // fits inside `stop = min(total - 1, offset + limit - 1)` clamp.
      vi.mocked(redis.llen).mockResolvedValue(100);
      vi.mocked(redis.lrange).mockResolvedValue([
        JSON.stringify({ timestamp: '2024-01-01T00:00:00Z', level: 'INFO', message: 'Log' }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/run-1/logs?offset=10&limit=50',
      });

      expect(response.statusCode).toBe(200);
      expect(redis.lrange).toHaveBeenCalledWith('logs:run-1', 10, 59);

      const body = JSON.parse(response.body);
      expect(body.data.offset).toBe(10);
      expect(body.data.limit).toBe(50);
      expect(body.data.total).toBe(100);
    });

    it('should default to limit=500 from offset 0', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      // 600 stored — page slice is rows 0..499
      vi.mocked(redis.llen).mockResolvedValue(600);
      vi.mocked(redis.lrange).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/run-1/logs',
      });

      expect(response.statusCode).toBe(200);
      // Default: limit=500, offset=0 → stop = min(599, 499) = 499
      expect(redis.lrange).toHaveBeenCalledWith('logs:run-1', 0, 499);

      const body = JSON.parse(response.body);
      expect(body.data.offset).toBe(0);
      expect(body.data.limit).toBe(500);
    });

    it('tail=true returns the LAST `limit` lines', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });
      // 23,481 lines stored — tail with limit=500 should fetch rows 22981..23480
      vi.mocked(redis.llen).mockResolvedValue(23_481);
      vi.mocked(redis.lrange).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/actor-runs/run-1/logs?tail=true&limit=500',
      });

      expect(response.statusCode).toBe(200);
      expect(redis.lrange).toHaveBeenCalledWith('logs:run-1', 22_981, 23_480);
      const body = JSON.parse(response.body);
      expect(body.data.offset).toBe(22_981);
      expect(body.data.total).toBe(23_481);
    });
  });
});
