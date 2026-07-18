/**
 * API-key auth cache tests.
 *
 * Guards the ingest hot path: validateApiKey used to run a bcrypt cost-10
 * compare (~69ms of main-thread CPU) against EVERY active key row on EVERY
 * cp_-key request, capping the api at ~7 req/s per instance while pinning
 * the event loop (2026-07-17 prod incident). The cache must guarantee:
 *   - at most one bcrypt sweep per key per TTL window (zero when warm)
 *   - last_used_at is written at most once per TTL window, not per request
 *   - revocation invalidates the local cache immediately
 *   - a failed verify is never cached
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type * as AuthModule from '../src/auth/index.js';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

// Keep the real bcrypt implementations but wrap verifyApiKey in a spy so
// tests can count how many compares each request costs.
vi.mock('../src/auth/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, verifyApiKey: vi.fn(actual.verifyApiKey) };
});

import { authenticate } from '../src/auth/middleware.js';
import { verifyApiKey, hashApiKey } from '../src/auth/index.js';
import {
  configureApiKeyCache,
  clearApiKeyCache,
  invalidateApiKey,
} from '../src/auth/api-key-cache.js';

const VALID_KEY = 'cp_' + 'a'.repeat(64);
const WRONG_KEY = 'cp_' + 'b'.repeat(64);
let validHash: string;

function makeRequest(token: string): FastifyRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    query: {},
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply: Record<string, unknown> = { sent: false };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((body: unknown) => {
    reply.body = body;
    reply.sent = true;
    return reply;
  });
  return reply as unknown as FastifyReply & { statusCode?: number; body?: unknown };
}

function selectCalls(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('SELECT id, key_hash')
  );
}

function touchCalls(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('UPDATE api_keys SET last_used_at')
  );
}

beforeAll(async () => {
  validHash = await hashApiKey(VALID_KEY);
});

beforeEach(() => {
  mockPoolQuery.mockReset();
  vi.mocked(verifyApiKey).mockClear();
  clearApiKeyCache();
  configureApiKeyCache({ ttlSecs: 300 });
  mockPoolQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id, key_hash')) {
      return {
        rows: [{ id: 'key-1', key_hash: validHash, user_id: 'user-1' }],
      };
    }
    return { rows: [] };
  });
});

describe('api-key auth cache', () => {
  it('cold request verifies via bcrypt and authenticates', async () => {
    const request = makeRequest(VALID_KEY);
    await authenticate(request, makeReply());

    expect(request.user).toEqual({ id: 'user-1', email: '', role: 'user' });
    expect(selectCalls()).toHaveLength(1);
    expect(vi.mocked(verifyApiKey).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('warm request does zero bcrypt compares and zero key-table reads', async () => {
    await authenticate(makeRequest(VALID_KEY), makeReply());
    vi.mocked(verifyApiKey).mockClear();
    const selectsAfterCold = selectCalls().length;

    const request = makeRequest(VALID_KEY);
    await authenticate(request, makeReply());

    expect(request.user).toEqual({ id: 'user-1', email: '', role: 'user' });
    expect(vi.mocked(verifyApiKey)).not.toHaveBeenCalled();
    expect(selectCalls()).toHaveLength(selectsAfterCold);
  });

  it('writes last_used_at at most once per TTL window, not per request', async () => {
    await authenticate(makeRequest(VALID_KEY), makeReply());
    expect(touchCalls()).toHaveLength(1);

    await authenticate(makeRequest(VALID_KEY), makeReply());
    await authenticate(makeRequest(VALID_KEY), makeReply());
    expect(touchCalls()).toHaveLength(1);
  });

  it('re-verifies after the TTL expires', async () => {
    // Real sleep, deliberately NOT vi.useFakeTimers(): the cold path awaits
    // a real bcryptjs compare, which slices its async work through
    // setImmediate/setTimeout — faking those timers deadlocks the await.
    // The 10x margin (20ms TTL vs 200ms sleep) keeps this stable on slow
    // CI runners instead.
    configureApiKeyCache({ ttlSecs: 0.02 });
    await authenticate(makeRequest(VALID_KEY), makeReply());
    vi.mocked(verifyApiKey).mockClear();

    await new Promise((r) => setTimeout(r, 200));

    const request = makeRequest(VALID_KEY);
    await authenticate(request, makeReply());
    expect(request.user?.id).toBe('user-1');
    expect(vi.mocked(verifyApiKey).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(touchCalls()).toHaveLength(2);
  });

  it('never caches a failed verify', async () => {
    const reply1 = makeReply();
    await authenticate(makeRequest(WRONG_KEY), reply1);
    expect(reply1.statusCode).toBe(401);
    const comparesFirst = vi.mocked(verifyApiKey).mock.calls.length;
    expect(comparesFirst).toBeGreaterThanOrEqual(1);

    const reply2 = makeReply();
    await authenticate(makeRequest(WRONG_KEY), reply2);
    expect(reply2.statusCode).toBe(401);
    expect(vi.mocked(verifyApiKey).mock.calls.length).toBe(comparesFirst * 2);
  });

  it('invalidateApiKey evicts the cached entry immediately', async () => {
    await authenticate(makeRequest(VALID_KEY), makeReply());
    invalidateApiKey('key-1');

    // Key is now revoked in the DB as well.
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id, key_hash')) return { rows: [] };
      return { rows: [] };
    });

    const reply = makeReply();
    const request = makeRequest(VALID_KEY);
    await authenticate(request, reply);
    expect(request.user).toBeUndefined();
    expect(reply.statusCode).toBe(401);
  });

  it('ttlSecs: 0 disables caching entirely (previous behavior)', async () => {
    configureApiKeyCache({ ttlSecs: 0 });
    await authenticate(makeRequest(VALID_KEY), makeReply());
    await authenticate(makeRequest(VALID_KEY), makeReply());

    expect(selectCalls()).toHaveLength(2);
    expect(touchCalls()).toHaveLength(2);
  });

  it('sha256-indexed lookup authenticates with zero bcrypt compares', async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id, user_id FROM api_keys WHERE key_sha256')) {
        return { rows: [{ id: 'key-1', user_id: 'user-1' }] };
      }
      return { rows: [] };
    });

    const request = makeRequest(VALID_KEY);
    await authenticate(request, makeReply());

    expect(request.user).toEqual({ id: 'user-1', email: '', role: 'user' });
    expect(vi.mocked(verifyApiKey)).not.toHaveBeenCalled();
    expect(selectCalls()).toHaveLength(0); // legacy sweep never reached
  });

  it('unknown keys are rejected with zero bcrypt compares once no legacy rows remain', async () => {
    mockPoolQuery.mockImplementation(async () => ({ rows: [] }));

    const reply = makeReply();
    await authenticate(makeRequest(WRONG_KEY), reply);

    expect(reply.statusCode).toBe(401);
    expect(vi.mocked(verifyApiKey)).not.toHaveBeenCalled();
  });

  it('legacy rows without key_sha256 are backfilled on successful bcrypt verify', async () => {
    await authenticate(makeRequest(VALID_KEY), makeReply());

    const backfills = mockPoolQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('UPDATE api_keys SET key_sha256')
    );
    expect(backfills).toHaveLength(1);
    expect(backfills[0][1]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), 'key-1']);
  });

  it('JWT authentication path is unaffected by the cache', async () => {
    const { createToken } = await vi.importActual<typeof AuthModule>('../src/auth/index.js');
    const jwt = createToken({ userId: 'admin-1', role: 'admin' });

    const request = makeRequest(jwt);
    await authenticate(request, makeReply());

    expect(request.user?.id).toBe('admin-1');
    expect(vi.mocked(verifyApiKey)).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
