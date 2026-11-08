/**
 * Default build + build-by-ID over the real wire (#117).
 *
 * apify-client `actor.defaultBuild()` calls GET /v2/actors/:id/builds/default,
 * then `.get()` calls GET /v2/actor-builds/:buildId and the MCP server reads
 * `actorDefinition` from that. Covers the default-build choice against
 * Postgres: rollback, RUNNING orphans, no builds, cross-user scoping.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

  it('concurrent pushes of different versions both record a build; one version holds latest', async () => {
    const actorId = await createActor('race', {
      defaultRunOptions: { image: 'ghcr.io/alice/race:0' },
      version: '0.0',
      actorDefinition: definition('0.0', ['url']),
    });
    const { pool } = await import('../../src/db/index.js');

    // Several rounds: one pair of concurrent pushes does not reliably land in
    // the clear→claim window, a handful of them did before the fix.
    for (let round = 1; round <= 8; round++) {
      const versions = [`${String(round)}.1`, `${String(round)}.2`];
      await Promise.all(versions.map((v) => push(actorId, `ghcr.io/alice/race:${v}`, v, ['url'])));

      const builds = await pool.query<{ version_number: string }>(
        `SELECT v.version_number FROM actor_builds b
           JOIN actor_versions v ON v.id = b.version_id
          WHERE b.actor_id = $1 AND v.version_number = ANY($2)`,
        [actorId, versions]
      );
      expect(builds.rows.map((r) => r.version_number).sort()).toEqual(versions);

      const latest = await pool.query<{ id: string; version_number: string }>(
        `SELECT id, version_number FROM actor_versions WHERE actor_id = $1 AND build_tag = 'latest'`,
        [actorId]
      );
      expect(latest.rows).toHaveLength(1);
      expect(versions).toContain(latest.rows[0]!.version_number);
      // The tag and current_version_id move in the same transaction.
      const actor = await pool.query<{ current_version_id: string }>(
        'SELECT current_version_id FROM actors WHERE id = $1',
        [actorId]
      );
      expect(actor.rows[0]!.current_version_id).toBe(latest.rows[0]!.id);
    }
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

  it('20 concurrent pushes with distinct versions each record a build; actor image is the newest build', async () => {
    const actorId = await createActor('race20', {
      defaultRunOptions: { image: 'ghcr.io/alice/race20:0' },
      version: '0.0',
    });
    const { pool } = await import('../../src/db/index.js');

    const versions = Array.from({ length: 20 }, (_, i) => `2.${String(i)}`);
    const statuses = await Promise.all(
      versions.map(async (v) => {
        const res = await api(alice.token, 'PUT', `/acts/${actorId}`, {
          defaultRunOptions: { image: `ghcr.io/alice/race20:${v}` },
          version: v,
        });
        return res.status;
      })
    );
    expect(statuses).toEqual(versions.map(() => 200));

    const builds = await pool.query<{ version_number: string; image_name: string }>(
      `SELECT v.version_number, b.image_name FROM actor_builds b
         JOIN actor_versions v ON v.id = b.version_id
        WHERE b.actor_id = $1 AND v.version_number = ANY($2)`,
      [actorId, versions]
    );
    expect(builds.rows.map((r) => r.version_number).sort()).toEqual([...versions].sort());
    for (const r of builds.rows) {
      expect(r.image_name).toBe(`ghcr.io/alice/race20:${r.version_number}`);
    }

    const versionRows = await pool.query<{ build_tag: string | null }>(
      'SELECT build_tag FROM actor_versions WHERE actor_id = $1',
      [actorId]
    );
    expect(versionRows.rows).toHaveLength(21);
    expect(versionRows.rows.filter((r) => r.build_tag === 'latest')).toHaveLength(1);

    // The actor's image, the newest build, the latest tag and
    // current_version_id all name the same push.
    const newest = await pool.query<{ image_name: string; version_id: string }>(
      `SELECT image_name, version_id FROM actor_builds WHERE actor_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [actorId]
    );
    const actor = await pool.query<{
      default_run_options: { image: string };
      current_version_id: string;
    }>('SELECT default_run_options, current_version_id FROM actors WHERE id = $1', [actorId]);
    const latest = await pool.query<{ id: string }>(
      `SELECT id FROM actor_versions WHERE actor_id = $1 AND build_tag = 'latest'`,
      [actorId]
    );
    expect(actor.rows[0]!.default_run_options.image).toBe(newest.rows[0]!.image_name);
    expect(actor.rows[0]!.current_version_id).toBe(newest.rows[0]!.version_id);
    expect(latest.rows[0]!.id).toBe(newest.rows[0]!.version_id);
  });

  it('sequential rollback v1.0 -> v2.0 -> v1.0 records a third build and moves the tag back', async () => {
    const actorId = await createActor('seqroll', {
      defaultRunOptions: { image: 'ghcr.io/alice/seqroll:a' },
      version: '1.0',
    });
    for (const [image, version] of [
      ['ghcr.io/alice/seqroll:b', '2.0'],
      ['ghcr.io/alice/seqroll:c', '1.0'],
    ] as const) {
      const res = await api(alice.token, 'PUT', `/acts/${actorId}`, {
        defaultRunOptions: { image },
        version,
      });
      expect(res.status).toBe(200);
    }

    const list = (await (await api(alice.token, 'GET', `/acts/${actorId}/builds`)).json()) as {
      data: { items: Array<{ versionNumber: string; imageName: string; buildNumber: string }> };
    };
    expect(list.data.items.map((b) => [b.versionNumber, b.imageName, b.buildNumber])).toEqual([
      ['1.0', 'ghcr.io/alice/seqroll:c', '1.0.2'],
      ['2.0', 'ghcr.io/alice/seqroll:b', '2.0.1'],
      ['1.0', 'ghcr.io/alice/seqroll:a', '1.0.1'],
    ]);

    const versions = (await (
      await api(alice.token, 'GET', `/acts/${actorId}/versions`)
    ).json()) as {
      data: { items: Array<{ versionNumber: string; buildTag: string | null }> };
    };
    const tags = Object.fromEntries(versions.data.items.map((v) => [v.versionNumber, v.buildTag]));
    expect(tags).toEqual({ '1.0': 'latest', '2.0': null });
  });

  it('a failing build record surfaces as a 5xx instead of a silent 200', async () => {
    const actorId = await createActor('failrec', {
      defaultRunOptions: { image: 'ghcr.io/alice/failrec:1' },
      version: '0.1',
    });
    const { pool } = await import('../../src/db/index.js');
    // Make the build insert fail for this actor only.
    await pool.query(`CREATE OR REPLACE FUNCTION fail_failrec_build() RETURNS trigger AS $$
      BEGIN
        IF NEW.actor_id = '${actorId}' THEN RAISE EXCEPTION 'injected build failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fail_failrec_build BEFORE INSERT ON actor_builds
      FOR EACH ROW EXECUTE FUNCTION fail_failrec_build()`);
    try {
      const res = await api(alice.token, 'PUT', `/acts/${actorId}`, {
        defaultRunOptions: { image: 'ghcr.io/alice/failrec:2' },
        version: '0.2',
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS fail_failrec_build ON actor_builds');
      await pool.query('DROP FUNCTION IF EXISTS fail_failrec_build()');
    }
  });

  it('run start and rerun store the same buildNumber the builds API reports', async () => {
    const actorId = await createActor('bnum', {
      defaultRunOptions: { image: 'ghcr.io/alice/bnum:1' },
      version: '0.1',
    });
    for (const tag of ['2', '3']) {
      const res = await api(alice.token, 'PUT', `/acts/${actorId}`, {
        defaultRunOptions: { image: `ghcr.io/alice/bnum:${tag}` },
        version: '0.1',
      });
      expect(res.status).toBe(200);
    }

    const started = await api(alice.token, 'POST', `/acts/${actorId}/runs`, {});
    expect(started.status).toBe(201);
    const run = ((await started.json()) as { data: { id: string; buildNumber: string } }).data;
    const got = (
      (await (await api(alice.token, 'GET', `/actor-runs/${run.id}`)).json()) as {
        data: { buildId: string; buildNumber: string };
      }
    ).data;
    const build = (
      (await (await api(alice.token, 'GET', `/actor-builds/${got.buildId}`)).json()) as {
        data: { buildNumber: string };
      }
    ).data;
    expect(build.buildNumber).toBe('0.1.3');
    expect(run.buildNumber).toBe('0.1.3');
    expect(got.buildNumber).toBe(build.buildNumber);

    // Rerun needs a failed/aborted/timed-out origin.
    const { pool } = await import('../../src/db/index.js');
    await pool.query(`UPDATE runs SET status = 'FAILED', finished_at = NOW() WHERE id = $1`, [
      run.id,
    ]);
    const rerun = await api(alice.token, 'POST', `/actor-runs/${run.id}/rerun`);
    expect(rerun.status).toBe(201);
    const rerunData = ((await rerun.json()) as { data: { buildId: string; buildNumber: string } })
      .data;
    expect(rerunData.buildId).toBe(got.buildId);
    expect(rerunData.buildNumber).toBe('0.1.3');
  });

  it('POST /builds with no body creates a build instead of a 500; bad fields are a 400', async () => {
    const res = await fetch(`${baseUrl}/v2/acts/alice~x/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(201);
    const bad = await api(alice.token, 'POST', '/acts/alice~x/builds', { versionId: 42 });
    expect(bad.status).toBe(400);
  });

  it("POST /builds rejects another user's versionId", async () => {
    const bobActor = await api(bob.token, 'POST', '/acts', {
      name: 'bobs',
      defaultRunOptions: { image: 'ghcr.io/bob/bobs:1' },
      version: '0.1',
    });
    expect(bobActor.status).toBe(201);
    const bobId = ((await bobActor.json()) as { data: { id: string } }).data.id;
    const bobVersions = (await (await api(bob.token, 'GET', `/acts/${bobId}/versions`)).json()) as {
      data: { items: Array<{ id: string }> };
    };
    const res = await api(alice.token, 'POST', '/acts/alice~x/builds', {
      versionId: bobVersions.data.items[0].id,
    });
    expect(res.status).toBe(404);
  });

  it('waitForFinish on a RUNNING build polls a light status query and returns at the cap', async () => {
    const created = await api(alice.token, 'POST', '/acts/alice~x/builds', {});
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const { _dbState } = await import('../../src/db/index.js');
    const spy = vi.spyOn(_dbState.pool, 'query');
    try {
      const started = Date.now();
      const res = await api(alice.token, 'GET', `/actor-builds/${id}?waitForFinish=3`);
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { status: string } }).data.status).toBe('RUNNING');
      expect(elapsed).toBeGreaterThanOrEqual(2900);
      expect(elapsed).toBeLessThan(6000);

      const sqls = spy.mock.calls.map((c) => String(c[0]));
      // The full row (with its correlated build-number count) is read once.
      expect(sqls.filter((s) => s.includes('COUNT(b2.id)'))).toHaveLength(1);
      expect(
        sqls.filter((s) => s.trim().startsWith('SELECT b.status FROM actor_builds')).length
      ).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });
});
