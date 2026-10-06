/**
 * GET /v2/store (#119): query parsing, search escaping, SQL shape and the
 * Apify store-item response shape. User isolation and literal matching
 * against Postgres are in test/integration/store.int.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

import { storeRoutes, formatStoreItem, storeInputSchema } from '../src/routes/store.js';
import { StoreListQuerySchema } from '../src/schemas/store.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'actor-1',
  name: 'echo',
  username: 'alice',
  title: 'Echo',
  description: 'Echoes input',
  total_runs: 3,
  last_run_started_at: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

const inputSchema = { title: 'Input', type: 'object', properties: { url: { type: 'string' } } };

describe('StoreListQuerySchema', () => {
  it('applies defaults', () => {
    expect(StoreListQuerySchema.parse({})).toEqual({
      search: '',
      limit: 10,
      offset: 0,
      includeInputSchema: false,
      username: undefined,
    });
  });

  it.each([
    ['1', 1],
    ['50', 50],
    ['100', 100],
    ['1000', 100],
    ['0', 1],
  ])('clamps limit=%s to %s', (limit, expected) => {
    expect(StoreListQuerySchema.parse({ limit }).limit).toBe(expected);
  });

  it.each([
    [{ includeInputSchema: '1' }, 10],
    [{ includeInputSchema: '1', limit: '5' }, 5],
    [{ includeInputSchema: 'true', limit: '50' }, 10],
    [{ includeInputSchema: '0', limit: '50' }, 50],
  ])('caps limit at 10 with includeInputSchema (%j → %s)', (input, expected) => {
    const q = StoreListQuerySchema.parse(input);
    expect(q.limit).toBe(expected);
  });

  it('accepts and drops the Apify filters it does not support', () => {
    const q = StoreListQuerySchema.parse({
      search: ' echo ',
      offset: '20',
      username: 'alice',
      category: 'AI',
      pricingModel: 'FREE',
      allowsAgenticUsers: '1',
      sortBy: 'popularity',
      includeUnrunnableActors: '0',
    });
    expect(q).toEqual({
      search: 'echo',
      limit: 10,
      offset: 20,
      includeInputSchema: false,
      username: 'alice',
    });
  });

  it.each([{ offset: '-1' }, { limit: '-1' }, { limit: 'abc' }, { includeInputSchema: 'yes' }])(
    'rejects %j',
    (input) => {
      expect(StoreListQuerySchema.safeParse(input).success).toBe(false);
    }
  );
});

describe('storeInputSchema', () => {
  it('passes a schema with properties through', () => {
    expect(storeInputSchema(inputSchema)).toBe(inputSchema);
  });

  it.each([undefined, null, 'INPUT_SCHEMA.json', [], { type: 'object' }, { properties: [] }])(
    'maps %j to null',
    (input) => {
      expect(storeInputSchema(input)).toBeNull();
    }
  );
});

describe('formatStoreItem', () => {
  it('returns the Apify store item shape', () => {
    expect(formatStoreItem(row())).toEqual({
      id: 'actor-1',
      name: 'echo',
      username: 'alice',
      title: 'Echo',
      description: 'Echoes input',
      pictureUrl: null,
      userPictureUrl: null,
      categories: [],
      stats: { totalRuns: 3, lastRunStartedAt: new Date('2026-07-01T00:00:00Z') },
      currentPricingInfo: { pricingModel: 'FREE' },
      url: null,
    });
  });

  it('falls back to the name for a missing title and includes inputSchema when given', () => {
    const item = formatStoreItem(row({ title: null, last_run_started_at: null }), null);
    expect(item.title).toBe('echo');
    expect(item.stats.lastRunStartedAt).toBeNull();
    expect(item).toHaveProperty('inputSchema', null);
  });
});

describe('GET /v2/store', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQuery.mockReset();
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: { type: 'validation_error' } });
      }
      return reply.send(error);
    });
    await app.register(storeRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function mockList(rows: Record<string, unknown>[], schemas: Record<string, unknown>[] = []) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)::text AS total'))
        return { rows: [{ total: String(rows.length) }] };
      if (sql.includes('unnest(')) return { rows: schemas };
      return { rows };
    });
  }

  const sqlOf = (marker: string) =>
    mockQuery.mock.calls.find(([sql]) => (sql as string).includes(marker)) as
      | [string, unknown[]]
      | undefined;

  it('lists the caller’s actors newest-modified first with the Apify envelope', async () => {
    mockList([row()]);
    const res = await app.inject({ method: 'GET', url: '/v2/store' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toMatchObject({ total: 1, count: 1, offset: 0, limit: 10, desc: false });
    expect(body.data.items[0]).toMatchObject({
      id: 'actor-1',
      username: 'alice',
      stats: { totalRuns: 3, lastRunStartedAt: '2026-07-01T00:00:00.000Z' },
      currentPricingInfo: { pricingModel: 'FREE' },
      url: null,
    });
    expect(body.data.items[0]).not.toHaveProperty('inputSchema');

    const [sql, params] = sqlOf('LIMIT $');
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('r.user_id = a.user_id AND r.actor_id = a.id');
    expect(sql).toContain('ORDER BY a.modified_at DESC, a.id DESC');
    expect(params).toEqual(['test-user-id', 10, 0]);
    // No input schemas requested → no build query.
    expect(sqlOf('unnest(')).toBeUndefined();
  });

  it('searches name/title/description with escaped wildcards, exact name first', async () => {
    mockList([]);
    const res = await app.inject({
      method: 'GET',
      url: `/v2/store?search=${encodeURIComponent('50%_a\\b')}&limit=5&offset=2`,
    });

    expect(res.statusCode).toBe(200);
    const [sql, params] = sqlOf('LIMIT $');
    expect(sql).toContain('(a.name ILIKE $2 OR a.title ILIKE $2 OR a.description ILIKE $2)');
    expect(sql).toContain('ORDER BY (LOWER(a.name) = LOWER($3)) DESC, a.modified_at DESC');
    expect(params).toEqual(['test-user-id', '%50\\%\\_a\\\\b%', '50%_a\\b', 5, 2]);
    const [, countParams] = sqlOf('COUNT(*)::text AS total');
    expect(countParams).toEqual(['test-user-id', '%50\\%\\_a\\\\b%']);
  });

  it('filters on username (so another user’s name yields nothing)', async () => {
    mockList([]);
    const res = await app.inject({ method: 'GET', url: '/v2/store?username=bob' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ total: 0, count: 0, items: [] });
    const [sql, params] = sqlOf('LIMIT $');
    expect(sql).toContain('a.user_id = $1 AND u.username = $2');
    expect(params).toEqual(['test-user-id', 'bob', 10, 0]);
  });

  it('includeInputSchema=1 adds inputSchema from one batch query and caps limit', async () => {
    mockList(
      [row(), row({ id: 'actor-2', name: 'other' })],
      [{ actor_id: 'actor-1', input: inputSchema }]
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v2/store?includeInputSchema=1&limit=50',
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.limit).toBe(10);
    expect(data.items[0].inputSchema).toEqual(inputSchema);
    expect(data.items[1].inputSchema).toBeNull();

    const schemaCalls = mockQuery.mock.calls.filter(([sql]) => (sql as string).includes('unnest('));
    expect(schemaCalls).toHaveLength(1);
    expect(schemaCalls[0][0]).toContain("b.actor_definition -> 'input'");
    expect(schemaCalls[0][1]).toEqual([['actor-1', 'actor-2']]);
    expect(sqlOf('LIMIT $')[1]).toEqual(['test-user-id', 10, 0]);
  });

  it('rejects an invalid includeInputSchema', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/store?includeInputSchema=yes' });
    expect(res.statusCode).toBe(400);
  });
});
