/**
 * Runner-key self-heal tests.
 *
 * The 2026-07-17 production outage: Redis's `runner:api-key` raw value
 * diverged from the DB's `__runner_service_key` bcrypt hash. The old
 * presence-only reuse check ("row exists AND redis key exists AND admin
 * matches") kept trusting the poisoned pair on every boot, so every
 * actor container authenticated with a key the API rejected — 100% run
 * failures until manual credential surgery. setupRunnerApiKey must now
 * VERIFY the raw key against the row and regenerate on mismatch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPoolQuery, mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
}));

vi.mock('../src/db/index.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  },
}));

import { setupRunnerApiKey } from '../src/setup.js';
import { sha256ApiKey, hashApiKey } from '../src/auth/index.js';

const ADMIN = 'admin-1';
const RAW_KEY = 'cp_' + 'r'.repeat(64);

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'runner-key-1',
    user_id: ADMIN,
    key_hash: 'unused-bcrypt-hash',
    key_sha256: sha256ApiKey(RAW_KEY),
    ...overrides,
  };
}

function regenerationInserts(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO api_keys')
  );
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockRedisSet.mockResolvedValue('OK');
});

describe('setupRunnerApiKey self-heal', () => {
  it('reuses the key when the Redis raw value matches the row sha256', async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [keyRow()] };
      return { rows: [] };
    });
    mockRedisGet.mockResolvedValue(RAW_KEY);

    await setupRunnerApiKey(ADMIN);

    expect(regenerationInserts()).toHaveLength(0);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('regenerates when the Redis raw value does NOT match the row (split-brain)', async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [keyRow()] };
      return { rows: [] };
    });
    mockRedisGet.mockResolvedValue('cp_' + 'x'.repeat(64)); // poisoned value

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await setupRunnerApiKey(ADMIN);
    warnSpy.mockRestore();

    // Old row deactivated, new row inserted, Redis re-seeded — and the
    // inserted sha256 must match the raw key written to Redis.
    const deactivations = mockPoolQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('SET is_active = false')
    );
    expect(deactivations).toHaveLength(1);
    const inserts = regenerationInserts();
    expect(inserts).toHaveLength(1);
    const insertedSha = (inserts[0][1] as string[])[4];
    const [redisKeyName, redisRawValue] = mockRedisSet.mock.calls[0] as [string, string];
    expect(redisKeyName).toBe('runner:api-key');
    expect(sha256ApiKey(redisRawValue)).toBe(insertedSha);
  });

  it('falls back to bcrypt verification for legacy rows without key_sha256', async () => {
    const legacyHash = await hashApiKey(RAW_KEY);
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [keyRow({ key_sha256: null, key_hash: legacyHash })] };
      }
      return { rows: [] };
    });
    mockRedisGet.mockResolvedValue(RAW_KEY);

    await setupRunnerApiKey(ADMIN);

    expect(regenerationInserts()).toHaveLength(0);
  });

  it('still regenerates when Redis has no value at all', async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [keyRow()] };
      return { rows: [] };
    });
    mockRedisGet.mockResolvedValue(null);

    await setupRunnerApiKey(ADMIN);

    expect(regenerationInserts()).toHaveLength(1);
    expect(mockRedisSet).toHaveBeenCalled();
  });
});
