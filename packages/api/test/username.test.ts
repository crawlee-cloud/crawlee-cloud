import { describe, it, expect, vi } from 'vitest';
import {
  generateUsername,
  insertWithGeneratedUsername,
  usernameBase,
  usernameCandidate,
  USERNAME_MAX_LENGTH,
} from '../src/auth/username.js';
import { USERNAME_CASES, USERNAME_PATTERN } from './username-cases.js';

describe('generateUsername', () => {
  it('allocates the shared case table in order', async () => {
    const taken = new Set<string>();
    for (const { email, expected } of USERNAME_CASES) {
      const username = await generateUsername(email, (c) => taken.has(c));
      expect(username, email).toBe(expected);
      expect(username).toMatch(USERNAME_PATTERN);
      expect(username.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      taken.add(username);
    }
  });

  it('gives alice@a.com and alice@b.com alice and alice-2', async () => {
    const taken = new Set<string>();
    for (const email of ['alice@a.com', 'alice@b.com']) {
      taken.add(await generateUsername(email, (c) => taken.has(c)));
    }
    expect([...taken]).toEqual(['alice', 'alice-2']);
  });

  it('keeps a 40-character local part valid and within 30 chars across many collisions', async () => {
    const taken = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      const username = await generateUsername(`${'x.'.repeat(20)}@d${i}.com`, (c) => taken.has(c));
      expect(username).toMatch(USERNAME_PATTERN);
      expect(username.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      expect(taken.has(username)).toBe(false);
      taken.add(username);
    }
    expect([...taken].at(-1)).toBe('x-x-x-x-x-x-x-x-x-x-x-x-x-1200');
  });

  it('treats reserved names as taken without consulting exists()', async () => {
    const exists = vi.fn(() => false);
    expect(await generateUsername('system@x.com', exists)).toBe('system-2');
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith('system-2');
  });

  it('awaits an async exists()', async () => {
    const exists = async (c: string) => c === 'bob';
    expect(await generateUsername('bob@x.com', exists)).toBe('bob-2');
  });
});

describe('usernameBase / usernameCandidate', () => {
  it('falls back to user for an empty or all-symbol local part', () => {
    expect(usernameBase('')).toBe('user');
    expect(usernameBase('@x.com')).toBe('user');
    expect(usernameBase('._-+@x.com')).toBe('user');
  });

  it('shortens the base so a long suffix still fits, trimming a trailing dash', () => {
    const base = 'abcdefghijklmnopqrstuvwx-y';
    expect(base).toHaveLength(26);
    expect(usernameCandidate(base, 1)).toBe(base);
    expect(usernameCandidate(base, 99)).toBe(`${base}-99`);
    expect(usernameCandidate(base, 1000)).toBe('abcdefghijklmnopqrstuvwx-1000');
  });
});

describe('insertWithGeneratedUsername', () => {
  const conflict = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'users_username_key',
  });

  it('regenerates and retries on a users_username_key violation', async () => {
    // First existence check sees `carol` free; the INSERT then loses the
    // race to a concurrent insert, so the retry must see it taken.
    const takenAfterRace = new Set<string>();
    const db = {
      query: vi.fn(async (_sql: string, values?: unknown[]) => ({
        rows: takenAfterRace.has(values?.[0] as string) ? [{}] : [],
      })),
    };
    const insert = vi.fn(async (username: string) => {
      if (insert.mock.calls.length === 1) {
        takenAfterRace.add(username);
        throw conflict;
      }
      return username;
    });
    expect(await insertWithGeneratedUsername(db, 'carol@x.com', insert)).toBe('carol-2');
    expect(insert.mock.calls.map((c) => c[0])).toEqual(['carol', 'carol-2']);
  });

  it('rethrows other errors, including other unique violations', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const emailConflict = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'users_email_key',
    });
    const insert = vi.fn(async () => {
      throw emailConflict;
    });
    await expect(insertWithGeneratedUsername(db, 'dave@x.com', insert)).rejects.toBe(emailConflict);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const insert = vi.fn(async () => {
      throw conflict;
    });
    await expect(insertWithGeneratedUsername(db, 'erin@x.com', insert, 3)).rejects.toBe(conflict);
    expect(insert).toHaveBeenCalledTimes(3);
  });
});
