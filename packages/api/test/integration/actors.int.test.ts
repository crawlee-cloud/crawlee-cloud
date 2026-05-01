import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('Actors & Runs (integration)', () => {
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

  it('creates an actor and starts a run', async () => {
    // Create actor
    const create = await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'my-scraper' },
    });
    expect(create.statusCode).toBe(201);
    const actorId = create.json().data.id;

    // Start run
    const run = await app.inject({
      method: 'POST',
      url: `/v2/acts/${actorId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().data.id;
    expect(run.json().data.status).toBe('READY');

    // Get run
    const get = await app.inject({
      method: 'GET',
      url: `/v2/actor-runs/${runId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    // Apify v2 returns the parent actor id under `actId` (legacy field name)
    expect(get.json().data.actId).toBe(actorId);
  });

  it('lists only the current user actors (IDOR)', async () => {
    // User A creates actor
    await app.inject({
      method: 'POST',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'a-scraper' },
    });

    // User B
    const userB = await createTestUser('b@test.local', 'password123');
    const list = await app.inject({
      method: 'GET',
      url: '/v2/acts',
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(list.json().data.items).toHaveLength(0);
  });
});
