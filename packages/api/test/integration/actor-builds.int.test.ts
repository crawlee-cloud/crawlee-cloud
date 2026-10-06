/**
 * Default build + build-by-ID over the real wire (#117).
 *
 * apify-client `actor.defaultBuild()` calls GET /v2/actors/:id/builds/default,
 * then `.get()` calls GET /v2/actor-builds/:buildId and the MCP server reads
 * `actorDefinition` from that. Covers the default-build choice against
 * Postgres: rollback, RUNNING orphans, no builds, cross-user scoping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

const schema = (required: string[]) => ({
  title: 'Input',
  type: 'object',
  schemaVersion: 1,
  properties: {
    url: { title: 'URL', type: 'string', editor: 'textfield' },
    maxPages: { title: 'Max pages', type: 'integer' },
  },
  required,
});

const definition = (version: string, required: string[]) => ({
  actorSpecification: 1,
  name: 'x',
  version,
  input: schema(required),
  readme: `# x ${version}`,
});

describe('default build and /actor-builds (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: { userId: string; token: string };
  let bob: { userId: string; token: string };
  let client: ApifyClient;

  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function push(actorId: string, image: string, version: string, required: string[]) {
    const res = await api(alice.token, 'PUT', `/acts/${actorId}`, {
      defaultRunOptions: { image },
      version,
      actorDefinition: definition(version, required),
    });
    expect(res.status).toBe(200);
  }

  async function createActor(name: string, payload: Record<string, unknown> = {}) {
    const res = await api(alice.token, 'POST', '/acts', { name, ...payload });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    // Fixed usernames (alice/bob) must not collide with other files' users.
    await cleanDatabase();
    baseUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');

    alice = await createTestUser('alice-117@test.local', 'pw-alice-117', 'alice');
    bob = await createTestUser('bob-117@test.local', 'pw-bob-117', 'bob');
    client = new ApifyClient({ token: alice.token, baseUrl });
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  it("client.actor('alice/x').defaultBuild() then .get() returns the pushed actorDefinition", async () => {
    await createActor('x', {
      defaultRunOptions: { image: 'ghcr.io/alice/x:1' },
      version: '0.1',
      actorDefinition: definition('0.1', ['url']),
    });

    const buildClient = await client.actor('alice/x').defaultBuild({ waitForFinish: 10 });
    const build = (await buildClient.get()) as unknown as Record<string, unknown> & {
      actorDefinition: { input: unknown };
    };

    expect(build.status).toBe('SUCCEEDED');
    expect(build.actorDefinition.input).toEqual(schema(['url']));
    expect(build).toMatchObject({
      actId: build.actorId,
      userId: alice.userId,
      buildNumber: '0.1.1',
      versionNumber: '0.1',
      buildTag: 'latest',
      meta: {},
      stats: {},
      options: {},
    });

    // waitForFinish on the build itself (terminal → immediate).
    const again = await client.build(build.id as string).get({ waitForFinish: 5 });
    expect(again?.id).toBe(build.id);
  });

  it('rollback: re-pushing v0.1 after v0.2 makes the new v0.1 build the default', async () => {
    const actorId = await createActor('rollback', {
      defaultRunOptions: { image: 'ghcr.io/alice/rollback:1' },
      version: '0.1',
      actorDefinition: definition('0.1', ['url']),
    });
    await push(actorId, 'ghcr.io/alice/rollback:2', '0.2', ['url', 'maxPages']);

    let build = await (await client.actor(actorId).defaultBuild()).get();
    expect((build as unknown as { versionNumber: string }).versionNumber).toBe('0.2');

    await push(actorId, 'ghcr.io/alice/rollback:3', '0.1', ['maxPages']);

    build = await (await client.actor(actorId).defaultBuild()).get();
    const b = build as unknown as {
      versionNumber: string;
      imageName: string;
      buildNumber: string;
      actorDefinition: { input: unknown };
    };
    expect(b.versionNumber).toBe('0.1');
    expect(b.imageName).toBe('ghcr.io/alice/rollback:3');
    expect(b.buildNumber).toBe('0.1.2');
    expect(b.actorDefinition.input).toEqual(schema(['maxPages']));
  });

  it('a RUNNING orphan build created after the latest push is not the default', async () => {
    const actorId = await createActor('orphan', {
      defaultRunOptions: { image: 'ghcr.io/alice/orphan:1' },
      version: '0.1',
      actorDefinition: definition('0.1', ['url']),
    });
    const versions = (await (
      await api(alice.token, 'GET', `/acts/${actorId}/versions`)
    ).json()) as {
      data: { items: Array<{ id: string }> };
    };
    const orphan = await api(alice.token, 'POST', `/acts/${actorId}/builds`, {
      versionId: versions.data.items[0].id,
    });
    expect(orphan.status).toBe(201);
    const orphanBuild = ((await orphan.json()) as { data: { id: string; status: string } }).data;
    expect(orphanBuild.status).toBe('RUNNING');

    const res = await api(alice.token, 'GET', `/actors/alice~orphan/builds/default`);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { id: string; status: string } }).data;
    expect(data.id).not.toBe(orphanBuild.id);
    expect(data.status).toBe('SUCCEEDED');

    // The orphan itself stays readable, with waitForFinish returning its
    // non-terminal state after the wait.
    const started = Date.now();
    const direct = await client.build(orphanBuild.id).get({ waitForFinish: 1 });
    expect(direct?.status).toBe('RUNNING');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('builds/default on an actor with no builds returns 404 record-not-found', async () => {
    await createActor('empty');
    const res = await api(alice.token, 'GET', '/acts/alice~empty/builds/default');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('record-not-found');
  });

  it("another user's build ID returns 404 on /actor-builds/:id", async () => {
    const own = await (await client.actor('alice/x').defaultBuild()).get();
    expect(own).toBeDefined();

    const res = await api(bob.token, 'GET', `/actor-builds/${own.id}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('record-not-found');
    // …and apify-client maps that 404 to undefined.
    const bobClient = new ApifyClient({ token: bob.token, baseUrl });
    expect(await bobClient.build(own.id).get()).toBeUndefined();

    // Bob can't reach Alice's default build either.
    const def = await api(bob.token, 'GET', '/acts/alice~x/builds/default');
    expect(def.status).toBe(404);
  });

  it('build lists keep the dashboard shape and never include actorDefinition', async () => {
    const res = await api(alice.token, 'GET', '/acts/alice~rollback/builds');
    const items = ((await res.json()) as { data: { items: Array<Record<string, unknown>> } }).data
      .items;
    expect(items.map((i) => i.buildNumber)).toEqual(['0.1.2', '0.2.1', '0.1.1']);
    for (const item of items) {
      expect(item).not.toHaveProperty('actorDefinition');
      expect(item).toHaveProperty('imageName');
      expect(item).toHaveProperty('versionNumber');
      expect(item.userId).toBe(alice.userId);
    }
  });
});
