/**
 * Apify webhook `condition` over the wire (#149).
 *
 * apify-client sends the scope as `condition: { actorId | actorTaskId |
 * actorRunId }`. Zod used to strip it, so the webhook was stored unscoped and
 * fired for every run of the user. Here the real client creates webhooks and
 * the stored scope is checked against the runner's match predicate
 * (packages/runner/src/queue.ts triggerWebhooks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import { createTestApp, runMigrations, createTestUser, ensureS3Bucket } from './setup.js';

describe('webhook condition (integration, #149)', () => {
  let app: FastifyInstance;
  let client: ApifyClient;
  let actorId: string;
  let actorName: string;
  let otherActorId: string;
  let runId: string;
  let otherRunId: string;
  let userId: string;

  /** Webhook ids the runner would select for this run (same WHERE as queue.ts). */
  async function matching(run: { id: string; actId: string }): Promise<string[]> {
    const { query } = await import('../../src/db/index.js');
    const res = await query<{ id: string }>(
      `SELECT id FROM webhooks
        WHERE is_enabled = true
          AND (actor_id IS NULL OR actor_id = $1)
          AND (run_id IS NULL OR run_id = $2)
          AND user_id = $3`,
      [run.actId, run.id, userId]
    );
    return res.rows.map((r) => r.id);
  }

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const user = await createTestUser('webhook-condition@test.local', 'pw-webhook-cond-1');
    userId = user.userId;
    client = new ApifyClient({
      token: user.token,
      baseUrl: address.replace(/\/$/, ''),
      maxRetries: 0,
    });

    actorName = `cond-actor-${Date.now()}`;
    actorId = (await client.actors().create({ name: actorName })).id;
    otherActorId = (await client.actors().create({ name: `cond-other-${Date.now()}` })).id;
    runId = (await client.actor(actorId).start({})).id;
    otherRunId = (await client.actor(otherActorId).start({})).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('condition.actorId scopes the webhook to that actor and reads back', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: 'https://consumer.example.com/hook',
      condition: { actorId },
    });
    expect(hook.condition).toEqual({ actorId });

    const fetched = await client.webhook(hook.id).get();
    expect(fetched?.condition).toEqual({ actorId });

    expect(await matching({ id: runId, actId: actorId })).toContain(hook.id);
    expect(await matching({ id: otherRunId, actId: otherActorId })).not.toContain(hook.id);
  });

  it('condition.actorId accepts the actor name and stores the id', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.FAILED'],
      requestUrl: 'https://consumer.example.com/hook',
      condition: { actorId: actorName },
    });
    expect(hook.condition).toEqual({ actorId });
  });

  it('condition.actorRunId scopes the webhook to that run', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: 'https://consumer.example.com/hook',
      condition: { actorRunId: runId },
    });
    expect(hook.condition).toEqual({ actorRunId: runId });
    expect(await matching({ id: runId, actId: actorId })).toContain(hook.id);
    expect(await matching({ id: otherRunId, actId: actorId })).not.toContain(hook.id);
  });

  it('rejects an unknown actor or run with record-not-found', async () => {
    for (const condition of [{ actorId: 'no-such-actor' }, { actorRunId: 'no-such-run' }]) {
      await expect(
        client.webhooks().create({
          eventTypes: ['ACTOR.RUN.SUCCEEDED'],
          requestUrl: 'https://consumer.example.com/hook',
          condition,
        })
      ).rejects.toMatchObject({ statusCode: 404, type: 'record-not-found' });
    }
  });

  it('rejects condition.actorTaskId with 400 (no actor tasks)', async () => {
    await expect(
      client.webhooks().create({
        eventTypes: ['ACTOR.RUN.SUCCEEDED'],
        requestUrl: 'https://consumer.example.com/hook',
        condition: { actorTaskId: 'some-task' },
      })
    ).rejects.toMatchObject({ statusCode: 400, type: 'invalid-request' });
  });

  it('rejects a condition with more than one target', async () => {
    await expect(
      client.webhooks().create({
        eventTypes: ['ACTOR.RUN.SUCCEEDED'],
        requestUrl: 'https://consumer.example.com/hook',
        condition: { actorId, actorRunId: runId },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('headersTemplate is stored as headers', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: 'https://consumer.example.com/hook',
      condition: { actorId },
      headersTemplate: JSON.stringify({ 'X-Secret': 'abc' }),
    });
    const fetched = (await client.webhook(hook.id).get()) as unknown as {
      headers: Record<string, string>;
    };
    expect(fetched.headers).toEqual({ 'X-Secret': 'abc' });
  });

  it('update moves the webhook to another actor via condition.actorId', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: 'https://consumer.example.com/hook',
      condition: { actorId },
    });
    const updated = await client.webhook(hook.id).update({ condition: { actorId: otherActorId } });
    expect(updated.condition).toEqual({ actorId: otherActorId });
    expect(await matching({ id: runId, actId: actorId })).not.toContain(hook.id);
  });

  it('a webhook without condition stays global (legacy behaviour)', async () => {
    const hook = await client.webhooks().create({
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: 'https://consumer.example.com/hook',
    } as Parameters<ReturnType<ApifyClient['webhooks']>['create']>[0]);
    expect(hook.condition).toBeNull();
    expect(await matching({ id: otherRunId, actId: otherActorId })).toContain(hook.id);
  });
});
