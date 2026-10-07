/**
 * Actor definition (input schema, README) stored per build — #112.
 *
 * Covers the DB-state acceptance criteria: the definition lands on the build
 * row, definition-only updates mutate the latest build in place, updates
 * without a definition never clear it, new images carry the previous
 * definition over, and build lists never return the column.
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

const IMAGE_V1 = 'ghcr.io/acme/actor-def:v1';
const IMAGE_V2 = 'ghcr.io/acme/actor-def:v2';

const defA = {
  actorSpecification: 1,
  name: 'actor-def',
  version: '0.1',
  input: {
    title: 'Input',
    type: 'object',
    schemaVersion: 1,
    properties: { url: { title: 'URL', type: 'string', editor: 'textfield' } },
    required: ['url'],
  },
  readme: '# Actor def\n\nScrapes things.',
  // Unknown Apify keys must survive (passthrough).
  dockerfile: './Dockerfile',
  storages: { dataset: { actorSpecification: 1, views: {} } },
};

const defB = {
  ...defA,
  input: { ...defA.input, required: ['url', 'maxPages'] },
  readme: '# Actor def\n\nNow with pagination.',
};

interface BuildDbRow {
  id: string;
  image_name: string;
  actor_definition: Record<string, unknown> | null;
}

describe('Actor definition on builds (integration)', () => {
  let app: FastifyInstance;
  let token: string;

  async function builds(actorId: string): Promise<BuildDbRow[]> {
    const { pool } = await import('../../src/db/index.js');
    const res = await pool.query<BuildDbRow>(
      `SELECT id, image_name, actor_definition FROM actor_builds
        WHERE actor_id = $1 ORDER BY created_at ASC`,
      [actorId]
    );
    return res.rows;
  }

  async function createActor(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'actor-def', ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
  }

  function put(actorId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/v2/acts/${actorId}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const user = await createTestUser();
    token = user.token;
  });

  afterEach(async () => {
    // cleanDatabase deletes actor_versions before actors, but versioned
    // pushes set actors.current_version_id (a non-cascading FK) — unlink it.
    const { pool } = await import('../../src/db/index.js');
    await pool.query('UPDATE actors SET current_version_id = NULL');
    await cleanDatabase();
    const user = await createTestUser();
    token = user.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('migration is idempotent', async () => {
    await runMigrations();
    await runMigrations();
    const { pool } = await import('../../src/db/index.js');
    const col = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'actor_builds' AND column_name = 'actor_definition'`
    );
    expect(col.rows[0]?.data_type).toBe('jsonb');
  });

  it('POST with actorDefinition and an image stores it on the new build', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });
    const rows = await builds(actorId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_definition).toEqual(defA);
  });

  it('PUT with only a changed actorDefinition updates the latest build in place', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });
    const [before] = await builds(actorId);

    const res = await put(actorId, { actorDefinition: defB });
    expect(res.statusCode).toBe(200);

    const rows = await builds(actorId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].actor_definition).toEqual(defB);
  });

  it('PUT with same image + version and no actorDefinition leaves it unchanged', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });

    const res = await put(actorId, { defaultRunOptions: { image: IMAGE_V1 }, version: '0.1' });
    expect(res.statusCode).toBe(200);

    const rows = await builds(actorId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_definition).toEqual(defA);
  });

  it('PUT with a new image creates a build with the new definition; the old build keeps its own', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });

    const res = await put(actorId, {
      defaultRunOptions: { image: IMAGE_V2 },
      version: '0.1',
      actorDefinition: defB,
    });
    expect(res.statusCode).toBe(200);

    const rows = await builds(actorId);
    expect(rows.map((r) => r.image_name)).toEqual([IMAGE_V1, IMAGE_V2]);
    expect(rows[0].actor_definition).toEqual(defA);
    expect(rows[1].actor_definition).toEqual(defB);
  });

  it('PUT with a new image and no actorDefinition carries the previous definition over', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });

    const res = await put(actorId, { defaultRunOptions: { image: IMAGE_V2 }, version: '0.1' });
    expect(res.statusCode).toBe(200);

    const rows = await builds(actorId);
    expect(rows).toHaveLength(2);
    expect(rows[1].image_name).toBe(IMAGE_V2);
    expect(rows[1].actor_definition).toEqual(defA);
  });

  it('POST upsert re-push with the same image updates the definition without a new build', async () => {
    await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'actor-def',
        defaultRunOptions: { image: IMAGE_V1 },
        version: '0.1',
        actorDefinition: defB,
      },
    });
    expect(res.statusCode).toBe(200);
    const actorId = res.json().data.id as string;

    const rows = await builds(actorId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_definition).toEqual(defB);
  });

  it('actorDefinition on an actor with no image returns 400 and stores nothing', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'no-image', actorDefinition: defA },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().error.type).toBe('validation_error');
    expect(post.json().error.message).toBe('actorDefinition requires an image');

    const actorId = await createActor({});
    const res = await put(actorId, { actorDefinition: defA });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('actorDefinition requires an image');
    expect(await builds(actorId)).toHaveLength(0);
  });

  it('rejects an input schema over 500 KB with 400', async () => {
    const actorId = await createActor({ defaultRunOptions: { image: IMAGE_V1 } });
    const res = await put(actorId, {
      actorDefinition: {
        input: { type: 'object', properties: {}, description: 'x'.repeat(520 * 1024) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('validation_error');
    expect(JSON.stringify(res.json().error.details)).toContain('actorDefinition.input');
    expect((await builds(actorId))[0].actor_definition).toBeNull();
  });

  it('GET /v2/acts/:id/builds and the build detail do not return actor_definition', async () => {
    const actorId = await createActor({
      defaultRunOptions: { image: IMAGE_V1 },
      version: '0.1',
      actorDefinition: defA,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/v2/acts/${actorId}/builds`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(list.body).not.toContain('actor_definition');
    expect(list.body).not.toContain('actorDefinition');
    expect(list.body).not.toContain('Scrapes things');

    const get = await app.inject({
      method: 'GET',
      url: `/v2/acts/${actorId}/builds/${items[0].id as string}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain('Scrapes things');
  });
});
