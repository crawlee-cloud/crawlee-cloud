/**
 * Health Check Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Mock database
const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) as unknown },
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
}));

// Mock Redis
const mockPing = vi.fn();
vi.mock('../src/storage/redis.js', () => ({
  redis: { ping: () => mockPing() as unknown },
}));

// Mock S3
const mockSend = vi.fn();
vi.mock('../src/storage/s3.js', () => ({
  s3: { send: (...args: unknown[]) => mockSend(...args) as unknown },
}));

// Mock config
vi.mock('../src/config.js', () => ({
  config: { s3Bucket: 'test-bucket' },
}));

// (No scheduler mock needed — health.ts no longer imports from scheduler.js
// after the poll-based rewrite removed schedulerJobs from /health/ready.)

import { registerHealthRoutes } from '../src/health.js';

describe('Health Check Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerHealthRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health/live', () => {
    it('should return 200 with ok status', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when all checks pass', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      mockPing.mockResolvedValueOnce('PONG');
      mockSend.mockResolvedValueOnce({});

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.checks.db.status).toBe('ok');
      expect(body.checks.redis.status).toBe('ok');
      expect(body.checks.s3.status).toBe('ok');
      // body.schedulerJobs no longer exists — the field reported the count
      // of in-process per-schedule cron registrations, which the poll-based
      // scheduler doesn't have.
      expect(body).not.toHaveProperty('schedulerJobs');
    });

    it('should return 503 when database is down', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));
      mockPing.mockResolvedValueOnce('PONG');
      mockSend.mockResolvedValueOnce({});

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
      expect(body.checks.db.status).toBe('error');
      expect(body.checks.db.error).toBe('Connection refused');
      expect(body.checks.redis.status).toBe('ok');
    });

    it('should return 503 when Redis is down', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      mockPing.mockRejectedValueOnce(new Error('Redis unavailable'));
      mockSend.mockResolvedValueOnce({});

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
      expect(body.checks.redis.status).toBe('error');
    });
  });
});
