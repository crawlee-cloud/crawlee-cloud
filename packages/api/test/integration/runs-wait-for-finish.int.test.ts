/**
 * waitForFinish long-poll (integration)
 *
 * `apify-client`'s `run(id).waitForFinish()` re-requests GET /actor-runs/:id
 * with no delay while the run is non-terminal, relying on the server to hold
 * each request. Without the long-poll this produced thousands of requests per
 * wait. The integration stack has no runner, so the test plays the runner and
 * finishes the run via PUT /actor-runs/:id a few seconds after starting it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('GET /v2/actor-runs/:runId?waitForFinish (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token: string;
  let client: ApifyClient;
  const runGets = new Map<string, number>();

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace(/\/$/, '');

    // Count GET /v2/actor-runs/:id on the raw server — the app is already
    // `ready()`, so Fastify hooks can no longer be added.
    app.server.on('request', (req: IncomingMessage) => {
      const m = /^\/v2\/actor-runs\/([^/?]+)(\?|$)/.exec(req.url ?? '');
      if (req.method === 'GET' && m) runGets.set(m[1], (runGets.get(m[1]) ?? 0) + 1);
    });

    ({ token } = await createTestUser('wait-for-finish@test.local', 'pw-wait-for-finish-1'));
    client = new ApifyClient({ token, baseUrl });
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  async function startRun(name: string): Promise<string> {
    const actor = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: authHeaders(),
      payload: { name },
    });
    expect(actor.statusCode).toBe(201);
    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actor.json().data.id as string}/runs`,
      headers: authHeaders(),
      payload: {},
    });
    expect(run.statusCode).toBe(201);
    return run.json().data.id as string;
  }

  function finishRunAfter(runId: string, ms: number) {
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        app
          .inject({
            method: 'PUT',
            url: `/v2/actor-runs/${runId}`,
            headers: authHeaders(),
            payload: { status: 'SUCCEEDED' },
          })
          .then((res) => {
            expect(res.statusCode).toBe(200);
            resolve();
          }, reject);
      }, ms);
    });
  }

  it('client.run(id).waitForFinish() resolves with the terminal run in < 10 requests', async () => {
    const runId = await startRun('wff-client');
    const finished = finishRunAfter(runId, 3_000);

    const started = Date.now();
    const run = await client.run(runId).waitForFinish();
    const elapsed = Date.now() - started;
    await finished;

    expect(run.status).toBe('SUCCEEDED');
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(6_000);
    expect(runGets.get(runId)).toBeLessThan(10);
  });

  it('raw GET with waitForFinish=20 returns as soon as the run finishes', async () => {
    const runId = await startRun('wff-raw');
    const finished = finishRunAfter(runId, 2_000);

    const started = Date.now();
    const res = await fetch(`${baseUrl}/v2/actor-runs/${runId}?waitForFinish=20`, {
      headers: authHeaders(),
    });
    const elapsed = Date.now() - started;
    await finished;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('SUCCEEDED');
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_500);
  });

  it('returns the non-terminal state after waitForFinish seconds', async () => {
    const runId = await startRun('wff-timeout');

    const started = Date.now();
    const res = await fetch(`${baseUrl}/v2/actor-runs/${runId}?waitForFinish=2`, {
      headers: authHeaders(),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('READY');
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('returns 404 immediately for an unknown run', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/v2/actor-runs/does-not-exist?waitForFinish=20`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
