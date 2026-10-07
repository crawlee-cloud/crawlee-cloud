/**
 * GET /v2/store over the real wire (#119).
 *
 * apify-client `store().list()` is what the Apify MCP `search-actors` tool
 * calls (with `includeInputSchema` added to the client's params). Covers user
 * isolation, literal `%` / `_` / `\` search, the username filter, ordering
 * and the default build's input schema against Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

const inputSchema = {
  title: 'Input',
  type: 'object',
  schemaVersion: 1,
  properties: { message: { title: 'Message', type: 'string', editor: 'textfield' } },
  required: ['message'],
};

type StoreItem = Record<string, unknown> & { id: string; name: string; inputSchema?: unknown };
type StoreList = { total: number; count: number; limit: number; items: StoreItem[] };

describe('GET /v2/store (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let alice: { userId: string; token: string };
  let bob: { userId: string; token: string };
  let client: ApifyClient;
  const ids: Record<string, string> = {};

  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function createActor(token: string, name: string, payload: Record<string, unknown> = {}) {
    const res = await api(token, 'POST', '/acts', { name, ...payload });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function store(token: string, qs: string): Promise<StoreList> {
    const res = await api(token, 'GET', `/store?${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: StoreList }).data;
  }

  const names = (list: { items: { name: string }[] }) => list.items.map((i) => i.name);

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    // Fixed usernames must not collide with other files' users.
    await cleanDatabase();
    baseUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');

    alice = await createTestUser('alice-119@test.local', 'pw-alice-119', 'alice119');
    bob = await createTestUser('bob-119@test.local', 'pw-bob-119', 'bob119');
    client = new ApifyClient({ token: alice.token, baseUrl });

    ids.echo = await createActor(alice.token, 'echo', {
      title: 'Echo',
      description: 'Echoes its input',
      defaultRunOptions: { image: 'ghcr.io/alice/echo:1' },
      version: '0.1',
      actorDefinition: { actorSpecification: 1, name: 'echo', version: '0.1', input: inputSchema },
    });
    // Modified after `echo`, so it would sort first without the exact-match rule.
    ids.echoPlus = await createActor(alice.token, 'echo-plus', { title: 'Echo plus' });
    ids.percent = await createActor(alice.token, 'pct', { title: '100% done' });
    ids.percentDecoy = await createActor(alice.token, 'pct-decoy', { title: '100x done' });
    ids.underscore = await createActor(alice.token, 'under', { description: 'snake a_b case' });
    ids.underscoreDecoy = await createActor(alice.token, 'under-decoy', {
      description: 'snake axb case',
    });
    ids.backslash = await createActor(alice.token, 'slash', { description: 'path C:\\temp' });
    ids.backslashDecoy = await createActor(alice.token, 'slash-decoy', {
      description: 'path C:temp',
    });
    // Bob's actor matches every search alice runs below.
    ids.bobEcho = await createActor(bob.token, 'echo-bob', {
      title: 'Echo 100% a_b C:\\temp',
    });

    const { pool } = await import('../../src/db/index.js');
    await pool.query(`UPDATE actors SET modified_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      ids.echo,
    ]);
    await pool.query(
      `INSERT INTO runs (id, actor_id, user_id, created_at)
       VALUES ($1, $3, $4, '2026-07-01T00:00:00Z'), ($2, $3, $4, '2026-07-02T00:00:00Z')`,
      [nanoid(), nanoid(), ids.echo, alice.userId]
    );
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  it("client.store().list({ search: 'echo' }) returns the caller's actors, exact name first", async () => {
    const list = await client.store().list({ search: 'echo' });

    expect(list.items.map((i) => i.name)).toEqual(['echo', 'echo-plus']);
    expect(list).toMatchObject({ total: 2, count: 2, offset: 0, limit: 10 });
    expect(list.items[0]).toMatchObject({
      id: ids.echo,
      name: 'echo',
      username: 'alice119',
      title: 'Echo',
      description: 'Echoes its input',
      currentPricingInfo: { pricingModel: 'FREE' },
      url: null,
      stats: { totalRuns: 2, lastRunStartedAt: new Date('2026-07-02T00:00:00Z') },
    });
    expect(list.items[0]).not.toHaveProperty('inputSchema');
  });

  it('includeInputSchema (as the MCP server sends it) adds the default build schema', async () => {
    const storeClient = client.store();
    storeClient.params = { ...storeClient.params, includeInputSchema: true };
    const list = await storeClient.list({ search: 'echo', limit: 5, offset: 0 });

    const items = list.items as unknown as StoreItem[];
    expect(items.map((i) => i.name)).toEqual(['echo', 'echo-plus']);
    expect(items[0].inputSchema).toEqual(inputSchema);
    // No build → null, not absent.
    expect(items[1].inputSchema).toBeNull();
  });

  it('caps limit at 10 with includeInputSchema', async () => {
    expect((await store(alice.token, 'includeInputSchema=1&limit=50')).limit).toBe(10);
    expect((await store(alice.token, 'limit=50')).limit).toBe(50);
  });

  it("never returns another user's actors", async () => {
    const all = await store(alice.token, 'limit=100');
    expect(all.total).toBe(8);
    expect(names(all)).not.toContain('echo-bob');

    const bobList = await store(bob.token, 'search=echo');
    expect(names(bobList)).toEqual(['echo-bob']);
  });

  it.each([
    ['%', ['pct']],
    ['100%', ['pct']],
    ['_', ['under']],
    ['a_b', ['under']],
    ['\\', ['slash']],
    ['C:\\temp', ['slash']],
  ])('search %j matches literally', async (search, expected) => {
    const list = await store(alice.token, `search=${encodeURIComponent(search)}`);
    expect(names(list)).toEqual(expected);
  });

  it('username filter: own username lists, anyone else is empty', async () => {
    expect(names(await store(alice.token, 'username=alice119&search=echo'))).toEqual([
      'echo',
      'echo-plus',
    ]);
    const other = await client.store().list({ username: 'bob119' });
    expect(other).toMatchObject({ total: 0, count: 0, items: [] });
  });

  it('pages with offset', async () => {
    const page = await store(alice.token, 'search=echo&limit=1&offset=1');
    expect(page).toMatchObject({ total: 2, count: 1, limit: 1 });
    expect(names(page)).toEqual(['echo-plus']);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/v2/store`);
    expect(res.status).toBe(401);
  });
});
