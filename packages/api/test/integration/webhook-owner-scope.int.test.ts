/**
 * Run-event webhooks fire only for their owner's runs — on every path that
 * queues deliveries, against real Postgres:
 *   1. API READY-abort (routes/runs.ts → queueAbortedWebhooks)
 *   2. runner (packages/runner/src/queue.ts → triggerWebhooks)
 *   3. scaler reaper (scaler/index.ts → enqueueRunEventWebhooks)
 *
 * Two users: A owns the actor and runs; B has a global webhook (actor_id
 * NULL) and one pointed at A's actor id. Only A's global webhook may get
 * deliveries. The three WHERE clauses are also compared as source text by
 * packages/runner/test/webhook-retry.test.ts; this proves the SQL itself.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, runMigrations, createTestUser, cleanDatabase } from './setup.js';

describe('Run-event webhooks are scoped to the run owner (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  /** A's actor + a READY run; A's and B's webhooks for `eventType`. */
  async function seed(eventType: string) {
    const a = await createTestUser('owner-a@scope.test.local', 'pw-owner-a-1');
    const b = await createTestUser('tenant-b@scope.test.local', 'pw-tenant-b-1');
    const actor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { name: 'scope-actor' },
    });
    const actorId = actor.json().data.id as string;

    const hook = async (token: string, extra: Record<string, unknown> = {}) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v2/webhooks',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          requestUrl: 'https://consumer.example.com/hook',
          eventTypes: [eventType],
          ...extra,
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().data.id as string;
    };
    const ownGlobal = await hook(a.token);
    await hook(b.token);
    await hook(b.token, { actorId });

    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    const runId = run.json().data.id as string;
    return { a, actorId, runId, ownGlobal };
  }

  async function deliveredWebhookIds(runId: string): Promise<string[]> {
    const { query } = await import('../../src/db/index.js');
    const res = await query<{ webhook_id: string }>(
      'SELECT webhook_id FROM webhook_deliveries WHERE run_id = $1',
      [runId]
    );
    return res.rows.map((r) => r.webhook_id);
  }

  it('API READY-abort queues deliveries only for the owner', async () => {
    const { a, runId, ownGlobal } = await seed('ACTOR.RUN.ABORTED');
    const abort = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${runId}/abort`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(abort.statusCode).toBe(200);
    expect(await deliveredWebhookIds(runId)).toEqual([ownGlobal]);
  });

  it('runner triggerWebhooks delivers only to the owner', async () => {
    const { runId, ownGlobal } = await seed('ACTOR.RUN.SUCCEEDED');
    const { pool, query } = await import('../../src/db/index.js');
    await query(`UPDATE runs SET status = 'SUCCEEDED', finished_at = NOW() WHERE id = $1`, [runId]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { triggerWebhooks } = await import('../../../runner/src/queue.js');
    await triggerWebhooks(runId, 'SUCCEEDED', pool);

    expect(await deliveredWebhookIds(runId)).toEqual([ownGlobal]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scaler reaper enqueues TIMED_OUT / FAILED deliveries only for the owner', async () => {
    for (const eventType of ['ACTOR.RUN.TIMED_OUT', 'ACTOR.RUN.FAILED'] as const) {
      const { a, actorId, runId, ownGlobal } = await seed(eventType);
      const { getClient } = await import('../../src/db/index.js');
      const { enqueueRunEventWebhooks } = await import('../../src/scaler/index.js');
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await enqueueRunEventWebhooks(
          client,
          [{ id: runId, actor_id: actorId, user_id: a.userId }],
          eventType
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await deliveredWebhookIds(runId)).toEqual([ownGlobal]);
      await cleanDatabase();
    }
  });
});
