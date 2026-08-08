/**
 * Rerun-as-new-run (integration)
 *
 * Exercises POST /v2/actor-runs/:runId/rerun against real Postgres /
 * Redis / MinIO. The critical contract is that the rerun is a NEW run:
 * fresh id + fresh storages + copied INPUT + copied per-run webhooks,
 * with the origin row left untouched. Downstream webhook consumers key
 * on the run id (some with UNIQUE create-only semantics), so a rerun
 * must never reuse the origin id — that's the whole reason this
 * endpoint exists next to resurrect.
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

describe('Run rerun (integration)', () => {
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

  /** Create an actor + a run with input/webhooks, then fail the run. */
  async function createFailedRun() {
    const createActor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name: 'rerun-actor', title: 'Rerun Actor' },
    });
    expect(createActor.statusCode).toBe(201);
    const actorId: string = createActor.json().data.id;

    const startRun = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
      payload: {
        input: { startUrls: ['https://example.com/coupons'], maxPages: 7 },
        timeout: 5400,
        memory: 2048,
        webhooks: [
          {
            eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
            requestUrl: 'https://consumer.test.local/webhooks/coupons',
            payloadTemplate: '{"locale":"cl","resource":{{resource}}}',
          },
        ],
      },
    });
    expect(startRun.statusCode).toBe(201);
    const origin = startRun.json().data;

    // Fake-runner: claim then fail the run.
    await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${origin.id}`,
      headers: authHeaders(),
      payload: { status: 'RUNNING' },
    });
    const failed = await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${origin.id}`,
      headers: authHeaders(),
      payload: { status: 'FAILED', statusMessage: 'Image pull failed: disk full' },
    });
    expect(failed.statusCode).toBe(200);

    return { actorId, origin };
  }

  it('creates a NEW run with fresh storages, copied INPUT, copied webhooks; origin untouched', async () => {
    ({ token } = await createTestUser('rerun@test.local', 'pw-rerun-1'));
    const { origin } = await createFailedRun();

    const rerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    expect(rerun.statusCode).toBe(201);
    const newRun = rerun.json().data;

    // Fresh identity + storages.
    expect(newRun.id).not.toBe(origin.id);
    expect(newRun.defaultDatasetId).not.toBe(origin.defaultDatasetId);
    expect(newRun.defaultKeyValueStoreId).not.toBe(origin.defaultKeyValueStoreId);
    expect(newRun.defaultRequestQueueId).not.toBe(origin.defaultRequestQueueId);
    expect(newRun.status).toBe('READY');
    expect(newRun.originRunId).toBe(origin.id);

    // Options carried over from the origin run.
    expect(newRun.options.timeoutSecs).toBe(5400);
    expect(newRun.options.memoryMbytes).toBe(2048);

    // INPUT copied byte-for-byte into the new KV store.
    const input = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${newRun.defaultKeyValueStoreId}/records/INPUT`,
      headers: authHeaders(),
    });
    expect(input.statusCode).toBe(200);
    expect(JSON.parse(input.body)).toEqual({
      startUrls: ['https://example.com/coupons'],
      maxPages: 7,
    });

    // Per-run webhooks copied onto the NEW run id (fresh webhook ids).
    const newHooks = await app.inject({
      method: 'GET',
      url: `/v2/webhooks?runId=${newRun.id}`,
      headers: authHeaders(),
    });
    expect(newHooks.statusCode).toBe(200);
    const hookItems = newHooks.json().data.items;
    expect(hookItems).toHaveLength(1);
    expect(hookItems[0].requestUrl).toBe('https://consumer.test.local/webhooks/coupons');
    expect(hookItems[0].eventTypes).toEqual(['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED']);

    // Origin row untouched: still FAILED, failure message intact.
    const originAfter = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs/${origin.id}`,
      headers: authHeaders(),
    });
    expect(originAfter.json().data.status).toBe('FAILED');
    expect(originAfter.json().data.statusMessage).toBe('Image pull failed: disk full');
  });

  it('collapses lineage: rerunning a failed rerun points at the ORIGINAL run', async () => {
    ({ token } = await createTestUser('rerun-chain@test.local', 'pw-rerun-2'));
    const { origin } = await createFailedRun();

    const firstRerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    const firstId: string = firstRerun.json().data.id;

    // Fail the first rerun, then rerun IT.
    await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${firstId}`,
      headers: authHeaders(),
      payload: { status: 'RUNNING' },
    });
    await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${firstId}`,
      headers: authHeaders(),
      payload: { status: 'FAILED' },
    });

    const secondRerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${firstId}/rerun`,
      headers: authHeaders(),
    });
    expect(secondRerun.statusCode).toBe(201);
    expect(secondRerun.json().data.originRunId).toBe(origin.id);
  });

  it('rejects a second rerun with 409 while the first clone is still queued (real advisory lock + check)', async () => {
    ({ token } = await createTestUser('rerun-dup@test.local', 'pw-rerun-6'));
    const { origin } = await createFailedRun();

    const first = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(201);

    // The first clone is READY (no runner in this harness), so a repeat
    // POST — double click, retried request — must not create a second one.
    const second = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.type).toBe('rerun-already-active');
  });

  it('rejects rerun with 409 input-not-found when the origin INPUT was reaped', async () => {
    ({ token } = await createTestUser('rerun-reaped@test.local', 'pw-rerun-7'));
    const { origin } = await createFailedRun();

    // Simulate retention reaping the origin's INPUT from object storage.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v2/key-value-stores/${origin.defaultKeyValueStoreId}/records/INPUT`,
      headers: authHeaders(),
    });
    expect([200, 204]).toContain(del.statusCode);

    const rerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    expect(rerun.statusCode).toBe(409);
    expect(rerun.json().error.type).toBe('input-not-found');
  });

  it('rejects rerun of a non-terminal run with 404', async () => {
    ({ token } = await createTestUser('rerun-guard@test.local', 'pw-rerun-3'));
    const { actorId } = await createFailedRun();

    // A second, still-READY run of the same actor.
    const readyRun = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
      payload: { input: {} },
    });
    const readyId: string = readyRun.json().data.id;

    const rerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${readyId}/rerun`,
      headers: authHeaders(),
    });
    expect(rerun.statusCode).toBe(404);
    expect(rerun.json().error.type).toBe('record-not-found');
  });

  it("rejects rerun of another user's run with 404", async () => {
    ({ token } = await createTestUser('rerun-owner@test.local', 'pw-rerun-4'));
    const { origin } = await createFailedRun();

    ({ token } = await createTestUser('rerun-intruder@test.local', 'pw-rerun-5'));
    const rerun = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${origin.id}/rerun`,
      headers: authHeaders(),
    });
    expect(rerun.statusCode).toBe(404);
  });
});
