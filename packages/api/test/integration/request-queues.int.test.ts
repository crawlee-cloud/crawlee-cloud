import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('Request Queues (integration)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const user = await createTestUser();
    token = user.token;
  });

  afterEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    token = user.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates queue, adds requests, locks and processes them', async () => {
    // Create queue
    const create = await app.inject({
      method: 'POST',
      url: '/v2/request-queues',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'crawl-queue' },
    });
    expect(create.statusCode).toBe(201);
    const queueId = create.json().data.id;

    // Add requests
    await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com/page1', uniqueKey: 'page1' },
    });
    await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com/page2', uniqueKey: 'page2' },
    });

    // Lock head
    const head = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/head/lock`,
      headers: { authorization: `Bearer ${token}` },
      payload: { lockSecs: 60, limit: 10 },
    });
    expect(head.statusCode).toBe(200);
    const locked = head.json().data.items;
    expect(locked.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates requests by uniqueKey', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v2/request-queues',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'dedup-queue' },
    });
    const queueId = create.json().data.id;

    // Add same URL twice
    await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com', uniqueKey: 'same' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueId}/requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://example.com', uniqueKey: 'same' },
    });
    // Second add should return the existing request (wasAlreadyPresent)
    expect(dup.json().data.wasAlreadyPresent).toBe(true);
  });

  it("cannot touch another user's request through the caller's own queue id", async () => {
    // User A: queue with one request, locked by A's crawler.
    const a = await createTestUser('rq-owner-a@test.local', 'pw-rq-owner-a-1');
    const authA = { authorization: `Bearer ${a.token}` };
    const qa = await app.inject({
      method: 'POST',
      url: '/v2/request-queues?name=owner-a-queue',
      headers: authA,
    });
    const queueA = qa.json().data.id;
    const added = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueA}/requests`,
      headers: authA,
      payload: { url: 'https://example.com/a', uniqueKey: 'a' },
    });
    const ridA = added.json().data.requestId;
    const lock = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueA}/head/lock?lockSecs=300&clientKey=crawler-a`,
      headers: authA,
    });
    expect(lock.json().data.items.map((r: { id: string }) => r.id)).toEqual([ridA]);

    // User B: own queue, then aims every per-request route at A's request id.
    const b = await createTestUser('rq-attacker-b@test.local', 'pw-rq-attacker-b-1');
    const authB = { authorization: `Bearer ${b.token}` };
    const qb = await app.inject({
      method: 'POST',
      url: '/v2/request-queues?name=attacker-b-queue',
      headers: authB,
    });
    const queueB = qb.json().data.id;
    const base = `/v2/request-queues/${queueB}/requests/${ridA}`;

    const attempts = [
      { method: 'DELETE' as const, url: `${base}/lock` },
      { method: 'DELETE' as const, url: `${base}/lock?forefront=1` },
      { method: 'PUT' as const, url: `${base}/lock?lockSecs=1` },
      { method: 'GET' as const, url: base },
      {
        method: 'PUT' as const,
        url: base,
        payload: { id: ridA, url: 'https://example.com/a', uniqueKey: 'a' },
      },
    ];
    for (const attempt of attempts) {
      const r = await app.inject({ ...attempt, headers: authB });
      expect(r.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(r.json().error.type).toBe('record-not-found');
    }

    // A's request is untouched: still locked by A, not moved to the head, and
    // a second A client is not served it again (no double crawl).
    const { pool } = await import('../../src/db/index.js');
    const row = await pool.query(
      `SELECT locked_by, locked_until > NOW() + INTERVAL '200 seconds' AS long_lock, order_no
         FROM requests WHERE id = $1`,
      [ridA]
    );
    expect(row.rows[0]).toMatchObject({ locked_by: 'crawler-a', long_lock: true });
    expect(Number(row.rows[0].order_no)).toBeGreaterThan(0);

    const again = await app.inject({
      method: 'POST',
      url: `/v2/request-queues/${queueA}/head/lock?lockSecs=60&clientKey=crawler-a2`,
      headers: authA,
    });
    expect(again.json().data.items).toEqual([]);
  });
});
