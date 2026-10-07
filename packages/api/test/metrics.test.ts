/**
 * Metrics Endpoint Tests
 *
 * Verifies that GET /metrics is gated by requireAdmin (admin-only),
 * mirrors the encapsulated-plugin pattern in src/index.ts, and that
 * the gating does NOT leak into sibling root routes like /health.
 *
 *  - unauthenticated -> 401
 *  - non-admin user  -> 403
 *  - admin           -> 200 with Prometheus text payload
 *  - sibling /health -> 200 without auth (encapsulation regression test)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

type Role = 'admin' | 'user';
type MockUser = { id: string; email: string; role: Role } | null;

// vi.hoisted so the mock factory shares the same `state` the tests mutate
// (vi.mock is hoisted above module-level `let`).
const { state } = vi.hoisted(() => ({
  state: { currentUser: null as MockUser },
}));

// Mock requireAdmin directly: the real implementation calls `authenticate`
// via an internal reference (not the export), so mocking only `authenticate`
// would have no effect. Coverage for requireAdmin's own logic lives in
// auth.test.ts.
vi.mock('../src/auth/middleware.js', () => ({
  requireAdmin: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!state.currentUser) {
      reply.status(401).send({ error: { message: 'Authentication required' } });
      return;
    }
    if (state.currentUser.role !== 'admin') {
      reply.status(403).send({ error: { message: 'Admin access required' } });
      return;
    }
    request.user = { ...state.currentUser };
  },
}));

import { requireAdmin } from '../src/auth/middleware.js';
import { registry, metricsRouteLabel } from '../src/metrics.js';

describe('Metrics Endpoint', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();

    // Mirror the encapsulated-plugin pattern in src/index.ts so this test
    // exercises the same gating shape that ships in production.
    await app.register(async (instance) => {
      instance.addHook('preHandler', requireAdmin);
      instance.get('/metrics', async (_request, reply) => {
        reply.header('Content-Type', registry.contentType);
        return registry.metrics();
      });
    });

    // Sibling root route — must remain unauthenticated. If a future
    // refactor accidentally hoists requireAdmin to the root instance,
    // this assertion fails.
    app.get('/health', () => ({ status: 'ok' }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    state.currentUser = null;
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    state.currentUser = { id: 'u1', email: 'u1@example.com', role: 'user' };
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(403);
  });

  it('returns Prometheus text format for admins', async () => {
    state.currentUser = { id: 'a1', email: 'admin@example.com', role: 'admin' };
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Default Node.js metrics
    expect(res.body).toContain('process_cpu');
    // Custom metrics
    expect(res.body).toContain('http_requests_total');
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toContain('actor_runs_total');
    expect(res.body).toContain('actor_runs_active');
    expect(res.body).toContain('webhook_deliveries_total');
    expect(res.body).toContain('scheduler_active_jobs');
    expect(res.body).toContain('db_pool_active_connections');
    expect(res.body).toContain('db_pool_idle_connections');
  });

  it('does not gate sibling routes — /health stays public', async () => {
    state.currentUser = null;
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('metricsRouteLabel', () => {
  it.each([
    ['/v2/actors', '/v2/acts'],
    ['/v2/actors/:actorId', '/v2/acts/:actorId'],
    ['/v2/actors/:actorId/runs', '/v2/acts/:actorId/runs'],
    ['/v2/actors/:actorId/builds/:buildId/abort', '/v2/acts/:actorId/builds/:buildId/abort'],
  ])('folds the /v2/actors alias %s onto %s', (route, expected) => {
    expect(metricsRouteLabel(route)).toBe(expected);
  });

  it.each([
    '/v2/acts/:actorId/runs',
    '/v2/actor-runs',
    '/v2/actor-runs/:runId',
    '/v2/actor-builds/:buildId',
    '/v2/actorsx',
    '/health',
  ])('leaves %s untouched', (route) => {
    expect(metricsRouteLabel(route)).toBe(route);
  });
});
