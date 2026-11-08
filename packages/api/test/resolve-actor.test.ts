/**
 * resolveActor (#114) — the shared user-scoped `:actorId` lookup.
 *
 * The SQL semantics (foreign usernames resolving to nothing, exact name
 * matches) are exercised against Postgres in
 * test/integration/resolve-actor.int.test.ts; these tests pin the parsing and
 * the parameters bound to the query.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { resolveActor, splitActorFullName } from '../src/lib/resolve-actor.js';

describe('splitActorFullName', () => {
  it.each([
    ['alice~my-actor', { username: 'alice', name: 'my-actor' }],
    ['alice/my-actor', { username: 'alice', name: 'my-actor' }],
    // Names may contain `.` and `-`; only the first separator splits.
    ['alice-2~my.actor-v1.2', { username: 'alice-2', name: 'my.actor-v1.2' }],
    ['alice/my~actor', { username: 'alice', name: 'my~actor' }],
  ])('splits %s', (input, expected) => {
    expect(splitActorFullName(input)).toEqual(expected);
  });

  it.each(['my-actor', 'my.actor', 'AbC123_xyz', '~my-actor', 'alice~', '/', ''])(
    'returns null for %j',
    (input) => {
      expect(splitActorFullName(input)).toBeNull();
    }
  );
});

describe('resolveActor', () => {
  const row = { id: 'actor-1', name: 'my.actor-1', user_id: 'user-1', username: 'alice' };

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it.each([
    ['id', 'actor-1', [null, null]],
    ['name', 'my.actor-1', [null, null]],
    ['username~name', 'alice~my.actor-1', ['alice', 'my.actor-1']],
    ['username/name', 'alice/my.actor-1', ['alice', 'my.actor-1']],
  ])('resolves the %s form', async (_form, input, split) => {
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    await expect(resolveActor(input, 'user-1')).resolves.toEqual(row);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([input, 'user-1', ...split]);
    // Always scoped to the caller, joined for the username, equality matches
    // only; username and name are case-insensitive, the id is not.
    expect(sql).toContain('WHERE a.user_id = $2');
    expect(sql).toContain('JOIN users u ON u.id = a.user_id');
    expect(sql).toContain('a.id = $1');
    expect(sql).toContain('lower(a.name) = lower($1)');
    expect(sql).toContain('(u.username = lower($3) AND lower(a.name) = lower($4))');
    // Several rows can match: exact id first, then exact-case name.
    expect(sql).toMatch(
      /ORDER BY \(a\.id = \$1\) DESC, \(a\.name = \$1 OR a\.name = \$4\) IS TRUE DESC, a\.id\s+LIMIT 1/
    );
    expect(sql).not.toMatch(/LIKE/i);
  });

  it('returns null for a foreign username (no row matches the caller)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(resolveActor('bob~my-actor', 'user-1')).resolves.toBeNull();
    expect(mockQuery.mock.calls[0][1]).toEqual(['bob~my-actor', 'user-1', 'bob', 'my-actor']);
  });

  it('runs on the given client (e.g. inside a transaction)', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) };

    await expect(resolveActor('actor-1', 'user-1', client)).resolves.toEqual(row);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
