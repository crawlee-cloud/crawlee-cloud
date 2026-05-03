/**
 * Schedule Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { schedulesRoutes } from '../src/routes/schedules.js';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
  pool: { query: vi.fn() },
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    publish: vi.fn(),
  },
}));

vi.mock('../src/scheduler.js', () => ({
  reloadSchedule: vi.fn(),
  unregisterSchedule: vi.fn(),
}));

const createScheduleRow = (overrides = {}) => ({
  id: 'schedule-1',
  user_id: 'test-user-id',
  actor_id: 'actor-1',
  name: 'My Schedule',
  cron_expression: '0 * * * *',
  timezone: 'UTC',
  is_enabled: true,
  input: null,
  last_run_at: null,
  next_run_at: null,
  created_at: new Date(),
  modified_at: new Date(),
  ...overrides,
});

describe('Schedule Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.setErrorHandler((error: any, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            type: 'validation_error',
            message: 'Validation failed',
            details: error.errors,
          },
        });
      }
      reply.status(500).send({ error: { message: error.message } });
    });
    app.register(schedulesRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('POST /v2/schedules', () => {
    it('should create a schedule', async () => {
      // First query: actor lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'actor-1' }] });
      // Second query: INSERT
      mockQuery.mockResolvedValueOnce({ rows: [createScheduleRow()] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/schedules',
        payload: {
          actorId: 'actor-1',
          name: 'My Schedule',
          cronExpression: '0 * * * *',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('schedule-1');
      expect(body.data.actorId).toBe('actor-1');
      expect(body.data.name).toBe('My Schedule');
      expect(body.data.cronExpression).toBe('0 * * * *');
      expect(body.data.isEnabled).toBe(true);
    });

    it('should return 404 when actor not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/schedules',
        payload: {
          actorId: 'non-existent',
          name: 'My Schedule',
          cronExpression: '0 * * * *',
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Actor not found');
    });

    it('should reject invalid cron expression', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/schedules',
        payload: {
          actorId: 'actor-1',
          name: 'My Schedule',
          cronExpression: 'not-valid',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v2/schedules', () => {
    it('should list user schedules with real total from COUNT(*)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/schedules',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
      expect(body.data.offset).toBe(0);
      expect(body.data.limit).toBe(100);
    });

    it('should return schedules when they exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '2' }] }).mockResolvedValueOnce({
        rows: [
          createScheduleRow(),
          createScheduleRow({ id: 'schedule-2', name: 'Second Schedule' }),
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/schedules',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });
  });

  describe('GET /v2/schedules/:scheduleId', () => {
    it('should get schedule by id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createScheduleRow()] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/schedules/schedule-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('schedule-1');
    });

    it('should return 404 for non-existent schedule', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/schedules/non-existent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Schedule not found');
    });
  });

  describe('PUT /v2/schedules/:scheduleId', () => {
    it('should update schedule', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createScheduleRow({ name: 'Updated Name' })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/schedules/schedule-1',
        payload: { name: 'Updated Name' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('Updated Name');
    });

    it('should return 404 for non-existent schedule', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/schedules/non-existent',
        payload: { name: 'Updated' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v2/schedules/:scheduleId', () => {
    it('should delete schedule', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'schedule-1' }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/schedules/schedule-1',
      });

      expect(response.statusCode).toBe(204);
    });

    it('should return 404 for missing schedule', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/schedules/non-existent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Schedule not found');
    });
  });
});
