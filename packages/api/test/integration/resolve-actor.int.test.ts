/**
 * username~name actor resolution and registry user scoping (#114, #77).
 *
 * Runs against real Postgres and a real HTTP listener so apify-client 2.25
 * (which sends `username/name` as `username~name`) is exercised on the wire.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('actor resolution by username~name (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: { userId: string; token: string };
  let bob: { userId: string; token: string };

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace(/\/$/, '');
  });

  beforeEach(async () => {
    alice = await createTestUser('alice@resolve.local', 'pw-alice-1', 'alice');
    bob = await createTestUser('bob@resolve.local', 'pw-bob-1', 'bob');
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createActor(token: string, name: string): Promise<{ id: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: auth(token),
      payload: { name },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data;
  }

  it('resolves id, name, username~name and username%2Fname for the owner', async () => {
    const actor = await createActor(alice.token, 'my-actor');

    for (const ref of [actor.id, 'my-actor', 'alice~my-actor', 'alice%2Fmy-actor']) {
      const r = await app.inject({
        method: 'GET',
        url: `/v2/acts/${ref}`,
        headers: auth(alice.token),
      });
      expect(r.statusCode, ref).toBe(200);
      expect(r.json().data).toMatchObject({ id: actor.id, name: 'my-actor', username: 'alice' });
    }
  });

  it("returns 404 record-not-found for another user's username", async () => {
    await createActor(bob.token, 'my-actor');
    await createActor(alice.token, 'my-actor');

    const r = await app.inject({
      method: 'GET',
      url: '/v2/acts/bob~my-actor',
      headers: auth(alice.token),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.type).toBe('record-not-found');
  });

  it('names containing . and - resolve exactly (no LIKE)', async () => {
    const dotted = await createActor(alice.token, 'my.actor-v1');
    await createActor(alice.token, 'myxactor-v1');

    const r = await app.inject({
      method: 'GET',
      url: '/v2/acts/alice~my.actor-v1',
      headers: auth(alice.token),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.id).toBe(dotted.id);
  });

  it('starts a run via POST /v2/acts/username~name/runs', async () => {
    const actor = await createActor(alice.token, 'my-actor');

    const r = await app.inject({
      method: 'POST',
      url: '/v2/acts/alice~my-actor/runs',
      headers: auth(alice.token),
      payload: {},
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.actId).toBe(actor.id);
  });

  it('resolves a 30-character username with a 100-character actor name', async () => {
    const username = 'u'.repeat(30);
    const long = await createTestUser('long@resolve.local', 'pw-long-1', username);
    const name = 'a'.repeat(100);
    const actor = await createActor(long.token, name);

    for (const ref of [`${username}~${name}`, `${username}%2F${name}`]) {
      const r = await app.inject({
        method: 'GET',
        url: `/v2/acts/${ref}`,
        headers: auth(long.token),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.id).toBe(actor.id);
    }
  });

  it('PUT/DELETE and schedules accept username~name', async () => {
    const actor = await createActor(alice.token, 'my-actor');

    const put = await app.inject({
      method: 'PUT',
      url: '/v2/acts/alice~my-actor',
      headers: auth(alice.token),
      payload: { title: 'Renamed' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ title: 'Renamed', username: 'alice' });

    const sched = await app.inject({
      method: 'POST',
      url: '/v2/schedules',
      headers: auth(alice.token),
      payload: { actorId: 'alice~my-actor', name: 'nightly', cronExpression: '0 0 * * *' },
    });
    expect(sched.statusCode).toBe(201);
    expect(sched.json().data.actorId).toBe(actor.id);

    const foreignSched = await app.inject({
      method: 'POST',
      url: '/v2/schedules',
      headers: auth(bob.token),
      payload: { actorId: 'alice~my-actor', name: 'nope', cronExpression: '0 0 * * *' },
    });
    expect(foreignSched.statusCode).toBe(404);

    // Remove the schedule first so the actor delete isn't blocked by it.
    await app.inject({
      method: 'DELETE',
      url: `/v2/schedules/${sched.json().data.id}`,
      headers: auth(alice.token),
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/v2/acts/alice~my-actor',
      headers: auth(alice.token),
    });
    expect(del.statusCode).toBe(204);
  });

  it('list items include username and stats.lastRunStartedAt; ?my=1 is ignored', async () => {
    const withRun = await createActor(alice.token, 'with-run');
    await createActor(alice.token, 'no-run');
    await createActor(bob.token, 'bobs-actor');
    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${withRun.id}/runs`,
      headers: auth(alice.token),
      payload: {},
    });
    expect(run.statusCode).toBe(201);

    const r = await app.inject({ method: 'GET', url: '/v2/acts?my=1', headers: auth(alice.token) });
    expect(r.statusCode).toBe(200);
    const items = r.json().data.items as Array<{
      name: string;
      username: string;
      stats: { lastRunStartedAt: string | null };
    }>;
    expect(items.map((i) => i.name).sort()).toEqual(['no-run', 'with-run']);
    for (const i of items) expect(i.username).toBe('alice');
    expect(items.find((i) => i.name === 'with-run').stats.lastRunStartedAt).toEqual(
      expect.any(String)
    );
    expect(items.find((i) => i.name === 'no-run').stats.lastRunStartedAt).toBeNull();
  });

  it('apify-client 2.25: client.actor("alice/my-actor").get() returns the actor', async () => {
    const actor = await createActor(alice.token, 'my-actor');
    const client = new ApifyClient({ token: alice.token, baseUrl });

    const got = await client.actor('alice/my-actor').get();
    expect(got).toMatchObject({ id: actor.id, name: 'my-actor', username: 'alice' });

    // Another user's actor is not found (SDK maps record-not-found → undefined).
    const bobClient = new ApifyClient({ token: bob.token, baseUrl });
    expect(await bobClient.actor('alice/my-actor').get()).toBeUndefined();
  });

  describe("registry routes on another user's actor (#77)", () => {
    let bobActorId: string;
    let bobVersionId: string;
    let bobBuildId: string;
    let aliceActorId: string;

    beforeEach(async () => {
      bobActorId = (await createActor(bob.token, 'bobs-actor')).id;
      aliceActorId = (await createActor(alice.token, 'alices-actor')).id;

      const v = await app.inject({
        method: 'POST',
        url: `/v2/acts/${bobActorId}/versions`,
        headers: auth(bob.token),
        payload: { versionNumber: '0.1' },
      });
      expect(v.statusCode).toBe(201);
      bobVersionId = v.json().data.id;

      const b = await app.inject({
        method: 'POST',
        url: `/v2/acts/${bobActorId}/builds`,
        headers: auth(bob.token),
        payload: {},
      });
      expect(b.statusCode).toBe(201);
      bobBuildId = b.json().data.id;
    });

    const routes = (): Array<{
      method: 'GET' | 'POST' | 'DELETE';
      path: string;
      payload?: object;
    }> => [
      { method: 'GET', path: 'versions' },
      { method: 'POST', path: 'versions', payload: { versionNumber: '9.9' } },
      { method: 'GET', path: `versions/${bobVersionId}` },
      { method: 'DELETE', path: `versions/${bobVersionId}` },
      { method: 'GET', path: 'builds' },
      { method: 'POST', path: 'builds', payload: {} },
      { method: 'GET', path: `builds/${bobBuildId}` },
      { method: 'POST', path: `builds/${bobBuildId}/abort` },
      { method: 'GET', path: `builds/${bobBuildId}/logs` },
    ];

    it("every registry route 404s for bob's actor ID, under /acts and /actors", async () => {
      for (const segment of ['acts', 'actors']) {
        for (const route of routes()) {
          const r = await app.inject({
            method: route.method,
            url: `/v2/${segment}/${bobActorId}/${route.path}`,
            headers: auth(alice.token),
            ...(route.payload ? { payload: route.payload } : {}),
          });
          expect(r.statusCode, `${route.method} ${segment}/${route.path}`).toBe(404);
          expect(r.json().error.type).toBe('record-not-found');
        }
      }

      // Nothing of bob's was changed: the version survives, the build still runs.
      const { pool } = await import('../../src/db/index.js');
      const v = await pool.query('SELECT 1 FROM actor_versions WHERE id = $1', [bobVersionId]);
      expect(v.rowCount).toBe(1);
      const b = await pool.query('SELECT status FROM actor_builds WHERE id = $1', [bobBuildId]);
      expect(b.rows[0].status).toBe('RUNNING');
      const versions = await pool.query('SELECT 1 FROM actor_versions WHERE actor_id = $1', [
        bobActorId,
      ]);
      expect(versions.rowCount).toBe(1);
    });

    it("build routes 404 for bob's build ID under alice's own actor", async () => {
      for (const path of [`builds/${bobBuildId}`, `builds/${bobBuildId}/logs`]) {
        const r = await app.inject({
          method: 'GET',
          url: `/v2/acts/${aliceActorId}/${path}`,
          headers: auth(alice.token),
        });
        expect(r.statusCode, path).toBe(404);
        expect(r.json().error.type).toBe('record-not-found');
      }
      const abort = await app.inject({
        method: 'POST',
        url: `/v2/acts/${aliceActorId}/builds/${bobBuildId}/abort`,
        headers: auth(alice.token),
      });
      expect(abort.statusCode).toBe(404);

      const { pool } = await import('../../src/db/index.js');
      const b = await pool.query('SELECT status FROM actor_builds WHERE id = $1', [bobBuildId]);
      expect(b.rows[0].status).toBe('RUNNING');
    });

    it('apify-client: another user’s versions and builds are not found', async () => {
      const client = new ApifyClient({ token: alice.token, baseUrl });
      expect(await client.actor('bob/bobs-actor').get()).toBeUndefined();
      await expect(client.actor(bobActorId).versions().list()).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(client.actor(bobActorId).builds().list()).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('the owner still reaches every registry route via username~name', async () => {
      const ok = await app.inject({
        method: 'GET',
        url: `/v2/acts/bob~bobs-actor/builds/${bobBuildId}`,
        headers: auth(bob.token),
      });
      expect(ok.statusCode).toBe(200);
      const versions = await app.inject({
        method: 'GET',
        url: '/v2/actors/bob~bobs-actor/versions',
        headers: auth(bob.token),
      });
      expect(versions.statusCode).toBe(200);
      expect(versions.json().data.total).toBe(1);
    });
  });
});
