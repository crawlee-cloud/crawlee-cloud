/**
 * Runs list filter + pagination (integration)
 *
 * GET /v2/actor-runs handles user triage at scale: 280 runs/day × 30 days =
 * 8,400 rows/user/month for the platform's target deployment. The route must:
 *   - return real total counts (not the page size — easy bug to ship)
 *   - paginate without overlap or skip across pages
 *   - filter by status, actorId, since/until without seq-scanning everything
 *   - never leak runs across users
 *
 * Each test pins one of those guarantees against real Postgres so the indexes
 * (idx_runs_user_*) plus query shape stay correct as the route evolves.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('Runs list / filter / pagination (integration)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  /** Create an actor; return its id. */
  async function makeActor(name: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data.id;
  }

  /** Start a run on the given actor; return its id. */
  async function startRun(actorId: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
    });
    expect(r.statusCode).toBe(201);
    return r.json().data.id;
  }

  /** Force a run into the given terminal/intermediate status via the PUT endpoint. */
  async function setStatus(runId: string, status: string): Promise<void> {
    const r = await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${runId}`,
      headers: authHeaders(),
      payload: { status },
    });
    expect(r.statusCode).toBe(200);
  }

  it('reports the REAL total, not the page size', async () => {
    ({ token } = await createTestUser('runs-total@test.local', 'pw-runs-total-1'));
    const actorId = await makeActor('total-actor');

    // Seed 7 runs, paginate at limit=3
    for (let i = 0; i < 7; i++) await startRun(actorId);

    const page = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?limit=3',
      headers: authHeaders(),
    });
    expect(page.statusCode).toBe(200);
    const body = page.json().data;

    // The original bug: total was set to result.rows.length (= page size).
    // After fix: total is COUNT(*) from the matching set.
    expect(body.total).toBe(7);
    expect(body.count).toBe(3);
    expect(body.limit).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it('paginates without overlap and without skipping rows', async () => {
    ({ token } = await createTestUser('runs-page@test.local', 'pw-runs-page-1'));
    const actorId = await makeActor('page-actor');

    for (let i = 0; i < 5; i++) await startRun(actorId);

    const p1 = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?limit=2&offset=0',
      headers: authHeaders(),
    });
    const p2 = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?limit=2&offset=2',
      headers: authHeaders(),
    });
    const p3 = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?limit=2&offset=4',
      headers: authHeaders(),
    });

    const ids1 = (p1.json().data.items as Array<{ id: string }>).map((r) => r.id);
    const ids2 = (p2.json().data.items as Array<{ id: string }>).map((r) => r.id);
    const ids3 = (p3.json().data.items as Array<{ id: string }>).map((r) => r.id);

    // No id appears on more than one page
    const seen = new Set<string>();
    for (const id of [...ids1, ...ids2, ...ids3]) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    // All 5 rows accounted for across 3 pages of 2/2/1
    expect(seen.size).toBe(5);
    expect(ids3).toHaveLength(1);
    expect(p3.json().data.total).toBe(5);
  });

  it('filters by status with the right total', async () => {
    ({ token } = await createTestUser('runs-status@test.local', 'pw-runs-status-1'));
    const actorId = await makeActor('status-actor');

    const a = await startRun(actorId);
    const b = await startRun(actorId);
    const c = await startRun(actorId);
    await setStatus(a, 'RUNNING');
    await setStatus(b, 'FAILED');
    // c stays READY

    const failed = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?status=FAILED',
      headers: authHeaders(),
    });
    expect(failed.json().data.total).toBe(1);
    expect(failed.json().data.items[0].id).toBe(b);

    const ready = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?status=READY',
      headers: authHeaders(),
    });
    expect(ready.json().data.total).toBe(1);
    expect(ready.json().data.items[0].id).toBe(c);
  });

  it('filters by actorId', async () => {
    ({ token } = await createTestUser('runs-actor@test.local', 'pw-runs-actor-1'));
    const actorA = await makeActor('actor-a');
    const actorB = await makeActor('actor-b');

    await startRun(actorA);
    await startRun(actorA);
    await startRun(actorB);

    const onlyA = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs?actorId=${actorA}`,
      headers: authHeaders(),
    });
    expect(onlyA.json().data.total).toBe(2);
    for (const item of onlyA.json().data.items) {
      expect(item.actId).toBe(actorA);
    }
  });

  it('rejects malformed limit / offset / status', async () => {
    ({ token } = await createTestUser('runs-validate@test.local', 'pw-runs-validate-1'));

    // limit=300 over the 200 cap → 400
    const tooBig = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?limit=300',
      headers: authHeaders(),
    });
    expect(tooBig.statusCode).toBe(400);

    // status not in enum → 400
    const badStatus = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs?status=SLEEPING',
      headers: authHeaders(),
    });
    expect(badStatus.statusCode).toBe(400);
  });

  /** GET a run list and return its item ids (asserting 200). */
  async function listIds(url: string): Promise<string[]> {
    const r = await app.inject({ method: 'GET', url, headers: authHeaders() });
    expect(r.statusCode).toBe(200);
    return (r.json().data.items as Array<{ id: string }>).map((i) => i.id);
  }

  it('accepts apify-client 1/0 booleans for desc; absent stays descending', async () => {
    ({ token } = await createTestUser('runs-desc@test.local', 'pw-runs-desc-1'));
    const actorId = await makeActor('desc-actor');
    const a = await startRun(actorId);
    const b = await startRun(actorId);
    const c = await startRun(actorId);

    expect(await listIds('/v2/actor-runs?desc=0')).toEqual([a, b, c]);
    expect(await listIds('/v2/actor-runs?desc=1')).toEqual([c, b, a]);
    expect(await listIds('/v2/actor-runs')).toEqual([c, b, a]);
  });

  it('filters by a comma-separated status list and accepts TIMING-OUT', async () => {
    ({ token } = await createTestUser('runs-multistatus@test.local', 'pw-runs-multistatus-1'));
    const actorId = await makeActor('multistatus-actor');
    const a = await startRun(actorId);
    const b = await startRun(actorId);
    await startRun(actorId); // stays READY
    await setStatus(a, 'SUCCEEDED');
    await setStatus(b, 'FAILED');

    const both = await listIds('/v2/actor-runs?status=SUCCEEDED,FAILED&desc=0');
    expect(both).toEqual([a, b]);

    expect(await listIds('/v2/actor-runs?status=TIMING-OUT')).toEqual([]);
  });

  it('treats startedAfter/startedBefore as since/until', async () => {
    ({ token } = await createTestUser('runs-started@test.local', 'pw-runs-started-1'));
    const actorId = await makeActor('started-actor');
    const a = await startRun(actorId);
    const b = await startRun(actorId);
    const c = await startRun(actorId);

    const get = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs/${b}`,
      headers: authHeaders(),
    });
    const bCreatedAt = new Date(get.json().data.createdAt).toISOString();

    expect(await listIds(`/v2/actor-runs?desc=0&startedAfter=${bCreatedAt}`)).toEqual([b, c]);
    expect(await listIds(`/v2/actor-runs?desc=0&startedBefore=${bCreatedAt}`)).toEqual([a]);
    expect(await listIds(`/v2/actor-runs?desc=0&since=${bCreatedAt}`)).toEqual([b, c]);
  });

  it('GET /v2/acts/:actorId/runs lists only that actor, by id or name; 404 for a foreign actor', async () => {
    ({ token } = await createTestUser('runs-peractor@test.local', 'pw-runs-peractor-1'));
    const actorA = await makeActor('per-actor-a');
    const actorB = await makeActor('per-actor-b');
    const a1 = await startRun(actorA);
    const a2 = await startRun(actorA);
    await startRun(actorB);

    expect(await listIds(`/v2/acts/${actorA}/runs`)).toEqual([a2, a1]);
    expect(await listIds('/v2/acts/per-actor-a/runs?desc=0')).toEqual([a1, a2]);

    const page = await app.inject({
      method: 'GET',
      url: '/v2/acts/per-actor-a/runs?limit=1',
      headers: authHeaders(),
    });
    expect(page.json().data).toMatchObject({ total: 2, count: 1, limit: 1, offset: 0, desc: true });

    // Another user can neither see the actor by id nor by name.
    ({ token } = await createTestUser('runs-peractor-other@test.local', 'pw-runs-peractor-2'));
    for (const ref of [actorA, 'per-actor-a']) {
      const r = await app.inject({
        method: 'GET',
        url: `/v2/acts/${ref}/runs`,
        headers: authHeaders(),
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.type).toBe('record-not-found');
    }
  });

  it('does not leak runs across users (IDOR via list)', async () => {
    // User A creates 3 runs
    ({ token } = await createTestUser('runs-owner@test.local', 'pw-runs-owner-1'));
    const actorId = await makeActor('owned-runs-actor');
    for (let i = 0; i < 3; i++) await startRun(actorId);

    // User B should see total=0
    ({ token } = await createTestUser('runs-otheruser@test.local', 'pw-runs-otheruser-1'));
    const r = await app.inject({
      method: 'GET',
      url: '/v2/actor-runs',
      headers: authHeaders(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.total).toBe(0);
    expect(r.json().data.items).toHaveLength(0);
  });
});
