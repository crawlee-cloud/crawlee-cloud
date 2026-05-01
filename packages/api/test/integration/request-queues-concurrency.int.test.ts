/**
 * Request-queue concurrency (integration)
 *
 * Exercises the distributed-locking semantics that make request queues safe
 * to drain from multiple workers in parallel:
 *
 *   - mutual exclusion: two workers racing for the same single request
 *     must not both receive it (Redis NX EX lock)
 *   - lock expiry: when a worker's lock TTL elapses without the request
 *     being marked handled, another worker must be able to pick it up
 *   - dedup: adding the same uniqueKey twice must return wasAlreadyPresent
 *
 * These tests hit real Postgres + Redis. They DO NOT use mocks for either —
 * the bugs we want to catch live in the interaction between the two stores.
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Request queue concurrency (integration)', () => {
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

  /** Create a queue and seed it with `count` distinct URLs. Returns the queue id. */
  async function seedQueue(count: number): Promise<string> {
    const create = await app.inject({
      method: 'POST',
      url: '/v2/request-queues',
      headers: authHeaders(),
      payload: { name: `q-${Date.now()}-${Math.random()}` },
    });
    expect(create.statusCode).toBe(201);
    const queueId = create.json().data.id;

    for (let i = 0; i < count; i++) {
      const add = await app.inject({
        method: 'POST',
        url: `/v2/request-queues/${queueId}/requests`,
        headers: authHeaders(),
        payload: { url: `https://example.com/p/${i}` },
      });
      expect(add.statusCode).toBe(201);
    }

    return queueId;
  }

  it('serializes /head/lock so no two workers hold the same request', async () => {
    ({ token } = await createTestUser('rq-mutex@test.local', 'pw-rq-mutex-1'));

    // Single request — at most one of the two workers can own it
    const queueId = await seedQueue(1);

    // Race two distinct clientKeys
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=10&clientKey=worker-A`,
        headers: authHeaders(),
      }),
      app.inject({
        method: 'POST',
        url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=10&clientKey=worker-B`,
        headers: authHeaders(),
      }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const aItems = a.json().data.items as Array<{ id: string }>;
    const bItems = b.json().data.items as Array<{ id: string }>;

    // Exactly one worker took the request; the other got an empty batch.
    const totalLocked = aItems.length + bItems.length;
    expect(totalLocked).toBe(1);

    // No request id appears in both batches (would indicate double-lock).
    const aIds = new Set(aItems.map((r) => r.id));
    const overlap = bItems.filter((r) => aIds.has(r.id));
    expect(overlap).toHaveLength(0);
  });

  it('grabs disjoint subsets across two clients and flips hadMultipleClients', async () => {
    ({ token } = await createTestUser('rq-partition@test.local', 'pw-rq-partition-1'));

    // /head/lock semantics: each call independently SELECTs the top `limit`
    // unlocked requests, then races to lock them via Redis NX. Under contention
    // one caller may win all 5 of the top-5 (total locked = 5). When timing
    // permits the first caller's UPDATE to commit before the second SELECT,
    // both get 5 (total = 10). The only firm invariants are:
    //   - no request id appears in both batches
    //   - progress is made (≥1 lock acquired)
    //   - hadMultipleClients reflects that two distinct clientKeys participated
    const queueId = await seedQueue(10);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=5&clientKey=worker-A`,
        headers: authHeaders(),
      }),
      app.inject({
        method: 'POST',
        url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=5&clientKey=worker-B`,
        headers: authHeaders(),
      }),
    ]);

    const aIds = new Set((a.json().data.items as Array<{ id: string }>).map((r) => r.id));
    const bIds = new Set((b.json().data.items as Array<{ id: string }>).map((r) => r.id));
    const intersection = [...aIds].filter((id) => bIds.has(id));

    expect(intersection).toHaveLength(0);
    expect(aIds.size + bIds.size).toBeGreaterThanOrEqual(1);
    expect(aIds.size + bIds.size).toBeLessThanOrEqual(10);

    // hadMultipleClients flips on as soon as two distinct clientKeys participate
    expect(a.json().data.hadMultipleClients || b.json().data.hadMultipleClients).toBe(true);
  });

  it('releases a request after the lock expires so another worker can claim it', async () => {
    ({ token } = await createTestUser('rq-expiry@test.local', 'pw-rq-expiry-1'));

    const queueId = await seedQueue(1);

    // Worker A locks for just 1 second
    const a = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/head/lock?lockSecs=1&limit=10&clientKey=worker-A`,
      headers: authHeaders(),
    });
    expect((a.json().data.items as unknown[]).length).toBe(1);
    const lockedId = (a.json().data.items as Array<{ id: string }>)[0].id;

    // Worker B tries immediately — must get nothing (still locked)
    const bImmediate = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=10&clientKey=worker-B`,
      headers: authHeaders(),
    });
    expect((bImmediate.json().data.items as unknown[]).length).toBe(0);

    // Wait past the Redis TTL + a small slop. The Postgres `locked_until`
    // filter uses `< NOW()` so we also need the wall clock to advance.
    await sleep(1500);

    // Worker B retries — request should be free again
    const bAfter = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&limit=10&clientKey=worker-B`,
      headers: authHeaders(),
    });
    const bItems = bAfter.json().data.items as Array<{ id: string }>;
    expect(bItems).toHaveLength(1);
    expect(bItems[0].id).toBe(lockedId);
  });

  it('deduplicates requests by uniqueKey on add', async () => {
    ({ token } = await createTestUser('rq-dedup@test.local', 'pw-rq-dedup-1'));

    const create = await app.inject({
      method: 'POST',
      url: '/v2/request-queues',
      headers: authHeaders(),
      payload: { name: 'dedup-q' },
    });
    const queueId = create.json().data.id;

    const first = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: authHeaders(),
      payload: { url: 'https://example.com/dup', uniqueKey: 'k1' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.wasAlreadyPresent).toBe(false);
    const firstId = first.json().data.requestId;

    const second = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: authHeaders(),
      payload: { url: 'https://example.com/dup', uniqueKey: 'k1' },
    });
    // Apify-compat: dedup returns the *original* request id, not a fresh one
    expect(second.json().data.wasAlreadyPresent).toBe(true);
    expect(second.json().data.requestId).toBe(firstId);
  });

  it('isolates queues across users (cross-user lock attempt is 404)', async () => {
    // User A creates a queue with one request
    ({ token } = await createTestUser('rq-owner-a@test.local', 'pw-rq-owner-a-1'));
    const queueId = await seedQueue(1);

    // User B tries to lock from User A's queue
    const userB = await createTestUser('rq-attacker-b@test.local', 'pw-rq-attacker-b-1');
    const attempt = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/head/lock?lockSecs=30&clientKey=intruder`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().error?.type).toBe('record-not-found');
  });
});
