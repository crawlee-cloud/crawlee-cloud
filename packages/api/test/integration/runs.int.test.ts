/**
 * Runs lifecycle (integration)
 *
 * Exercises the full Actor-run flow against real Postgres / Redis / MinIO,
 * without spinning up the Docker-based runner. The test plays the runner's
 * role itself by hitting the same endpoints the real runner uses
 * (see packages/runner/src/queue.ts):
 *
 *   1. user creates an actor
 *   2. user POSTs /acts/:id/runs        →  run created in READY status,
 *                                          default dataset/KV/queue auto-created
 *   3. fake-runner: PUT /actor-runs/:id  →  status RUNNING
 *   4. fake-runner: push dataset items, write OUTPUT to KV
 *   5. fake-runner: PUT /actor-runs/:id  →  status SUCCEEDED
 *   6. user reads run, dataset items, KV OUTPUT  →  cross-resource consistency
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

describe('Runs lifecycle (integration)', () => {
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

  /** Helper: bearer-auth headers for the current test user. */
  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('walks an actor run from READY → RUNNING → SUCCEEDED with consistent storages', async () => {
    ({ token } = await createTestUser('runner-lifecycle@test.local', 'pw-lifecycle-1'));

    // 1. Create actor
    const createActor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name: 'lifecycle-actor', title: 'Lifecycle Actor' },
    });
    expect(createActor.statusCode).toBe(201);
    const actorId: string = createActor.json().data.id;

    // 2. Start run (creates run in READY + auto-creates default storages)
    const startRun = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
      payload: { input: { startUrl: 'https://example.com' } },
    });
    expect(startRun.statusCode).toBe(201);
    const runStart = startRun.json().data;
    const runId: string = runStart.id;
    const datasetId: string = runStart.defaultDatasetId;
    const kvId: string = runStart.defaultKeyValueStoreId;
    const queueId: string = runStart.defaultRequestQueueId;

    expect(runStart.status).toBe('READY');
    expect(datasetId).toBeTruthy();
    expect(kvId).toBeTruthy();
    expect(queueId).toBeTruthy();

    // 3. Fake-runner picks up the run and flips to RUNNING
    const toRunning = await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${runId}`,
      headers: authHeaders(),
      payload: { status: 'RUNNING' },
    });
    expect(toRunning.statusCode).toBe(200);
    expect(toRunning.json().data.status).toBe('RUNNING');

    // 4a. Fake-runner: actor pushes dataset items
    const pushItems = await app.inject({
      method: 'POST',
      url: `/v2/datasets/${datasetId}/items`,
      headers: authHeaders(),
      payload: [
        { url: 'https://example.com', title: 'First' },
        { url: 'https://example.com/page-2', title: 'Second' },
      ],
    });
    expect(pushItems.statusCode).toBe(201);

    // 4b. Fake-runner: actor writes OUTPUT to default KV store
    const writeOutput = await app.inject({
      method: 'PUT',
      url: `/v2/key-value-stores/${kvId}/records/OUTPUT`,
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({ pages: 2, durationMs: 1234 }),
    });
    expect(writeOutput.statusCode).toBe(201);

    // 5. Fake-runner: mark SUCCEEDED
    const toSucceeded = await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${runId}`,
      headers: authHeaders(),
      payload: { status: 'SUCCEEDED' },
    });
    expect(toSucceeded.statusCode).toBe(200);

    // 6. User reads back the run and storages
    const finalRun = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs/${runId}`,
      headers: authHeaders(),
    });
    expect(finalRun.statusCode).toBe(200);

    const items = await app.inject({
      method: 'GET',
      url: `/v2/datasets/${datasetId}/items`,
      headers: authHeaders(),
    });
    expect(items.statusCode).toBe(200);

    const output = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${kvId}/records/OUTPUT`,
      headers: authHeaders(),
    });
    expect(output.statusCode).toBe(200);

    const run = finalRun.json().data;
    const dataset = items.json();
    const outputBody = output.json();

    // (1) Final state — catches regressions where PUT /actor-runs/:id silently
    // ignores status updates or doesn't stamp finished_at on terminal states.
    expect(run.status).toBe('SUCCEEDED');
    expect(run.finishedAt).toBeTruthy();
    expect(new Date(run.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(run.startedAt).getTime()
    );

    // (2) Apify-compat shape — `actId` (legacy field name), not `actorId`.
    // Re-pins the test bug we already fixed once in actors.int.test.ts.
    expect(run.actId).toBe(actorId);
    expect(run).not.toHaveProperty('actorId');

    // (3) Storage IDs are stable across the run — catches a class of bugs
    // where a re-fetch of the run returns DIFFERENT default-storage IDs than
    // the create response (e.g., if formatRun read from a stale row, or if
    // a cleanup path nulled the columns).
    expect(run.defaultDatasetId).toBe(runStart.defaultDatasetId);
    expect(run.defaultKeyValueStoreId).toBe(runStart.defaultKeyValueStoreId);
    expect(run.defaultRequestQueueId).toBe(runStart.defaultRequestQueueId);

    // (4) Dataset round-trip — items pushed by the (fake) runner come back
    // exactly. Catches S3 key collisions, ordering bugs, JSON re-serialization
    // drift. Length AND content, because length-only would miss a content swap.
    expect(dataset).toHaveLength(2);
    expect(dataset[0]).toEqual({ url: 'https://example.com', title: 'First' });
    expect(dataset[1]).toEqual({ url: 'https://example.com/page-2', title: 'Second' });

    // (5) Apify-compat: dataset items must be a raw array, not wrapped in
    // {data: [...]}. Pinning the project_dataset_listitems_shape memory —
    // wrapping would silently break apify-client's listItems().
    expect(Array.isArray(dataset)).toBe(true);

    // (6) OUTPUT KV round-trip — the JSON the runner wrote comes back parsed.
    // Catches content-type drift on the OUTPUT path (which is the actor's
    // canonical "this is my result" surface in Crawlee/Apify SDK).
    expect(outputBody).toEqual({ pages: 2, durationMs: 1234 });
  });

  it('cannot transition a run owned by another user (cross-user PUT is 404)', async () => {
    // User A starts a run
    ({ token } = await createTestUser('owner-a@test.local', 'pw-owner-a-1'));

    const actor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name: 'owned-actor' },
    });
    const actorId = actor.json().data.id;

    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
    });
    const runId = run.json().data.id;

    // User B tries to flip its status
    const userB = await createTestUser('attacker-b@test.local', 'pw-attacker-b-1');
    const attempt = await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${runId}`,
      headers: { authorization: `Bearer ${userB.token}` },
      payload: { status: 'SUCCEEDED' },
    });

    // Per Apify-compat memory: 404 with error.type='record-not-found',
    // not 403, so apify-client's catchNotFoundOrThrow path works.
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().error?.type).toBe('record-not-found');
  });

  it('aborts a RUNNING run and rejects abort on terminal runs', async () => {
    ({ token } = await createTestUser('aborter@test.local', 'pw-aborter-1'));

    const actor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name: 'abort-actor' },
    });
    const actorId = actor.json().data.id;

    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: authHeaders(),
    });
    const runId = run.json().data.id;

    // Move to RUNNING (abort endpoint requires RUNNING status)
    await app.inject({
      method: 'PUT',
      url: `/v2/actor-runs/${runId}`,
      headers: authHeaders(),
      payload: { status: 'RUNNING' },
    });

    const abort = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${runId}/abort`,
      headers: authHeaders(),
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json().data.status).toBe('ABORTED');

    // Aborting again is a no-op 404 (Apify-compat: record-not-found shape)
    const abortAgain = await app.inject({
      method: 'POST',
      url: `/v2/actor-runs/${runId}/abort`,
      headers: authHeaders(),
    });
    expect(abortAgain.statusCode).toBe(404);
    expect(abortAgain.json().error?.type).toBe('record-not-found');
  });
});
