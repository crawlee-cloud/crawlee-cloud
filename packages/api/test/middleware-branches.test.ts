/**
 * Auth middleware branch tests: authenticate's API-key paths (cache hit,
 * sha256 index hit, legacy bcrypt sweep + fingerprint backfill),
 * optionalAuth's never-fail contract, and requireAdmin's gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const authFns = vi.hoisted(() => ({
  extractToken: vi.fn(),
  verifyToken: vi.fn(),
  verifyApiKey: vi.fn(),
  sha256ApiKey: vi.fn(),
}));
vi.mock('../src/auth/index.js', () => authFns);

const cacheFns = vi.hoisted(() => ({
  getCachedApiKey: vi.fn(),
  cacheApiKey: vi.fn(),
  shouldTouchLastUsed: vi.fn(),
}));
vi.mock('../src/auth/api-key-cache.js', () => cacheFns);

import { authenticate, optionalAuth, requireAdmin } from '../src/auth/middleware.js';

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    headers: { authorization: 'Bearer some-token' },
    query: {},
    log: { error: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const reply = {
    sent: false,
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.sent = true;
      this.payload = payload;
      return this;
    },
  };
  return reply as unknown as FastifyReply & {
    statusCode: number;
    payload: { error?: { message: string } };
    sent: boolean;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authFns.extractToken.mockImplementation((header?: string) =>
    header?.startsWith('Bearer ') ? header.slice(7) : null
  );
  authFns.verifyToken.mockReturnValue(null);
  authFns.sha256ApiKey.mockReturnValue('sha-of-key');
  cacheFns.getCachedApiKey.mockReturnValue(null);
  cacheFns.shouldTouchLastUsed.mockReturnValue(false);
});

describe('authenticate', () => {
  it('rejects requests with no token anywhere', async () => {
    const request = fakeRequest({ headers: {} });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload.error?.message).toBe('Authentication required');
  });

  it('accepts a ?token= query fallback (dashboard download links)', async () => {
    authFns.verifyToken.mockReturnValue({ userId: 'u1', email: 'a@b.c', role: 'user' });
    const request = fakeRequest({ headers: {}, query: { token: 'jwt-from-url' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(reply.sent).toBe(false);
    expect(request.user).toEqual({ id: 'u1', email: 'a@b.c', role: 'user' });
    expect(authFns.verifyToken).toHaveBeenCalledWith('jwt-from-url');
  });

  it('authenticates a valid JWT without touching the database', async () => {
    authFns.verifyToken.mockReturnValue({ userId: 'u1', email: 'a@b.c', role: 'admin' });
    const request = fakeRequest();
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(request.user?.role).toBe('admin');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('serves a cached API key without any DB read, skipping last_used bookkeeping', async () => {
    cacheFns.getCachedApiKey.mockReturnValue({ id: 'key-1', user_id: 'u2' });
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_secret' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(request.user).toEqual({ id: 'u2', email: '', role: 'user' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('stamps last_used_at on the cached path once the TTL window elapses', async () => {
    cacheFns.getCachedApiKey.mockReturnValue({ id: 'key-1', user_id: 'u2' });
    cacheFns.shouldTouchLastUsed.mockReturnValue(true);
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_secret' } });

    await authenticate(request, fakeReply());

    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET last_used_at = NOW()');
    expect(params).toEqual(['key-1']);
  });

  it('resolves a fresh key via the sha256 index and caches it', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'key-9', user_id: 'u9' }] }) // sha lookup
      .mockResolvedValueOnce({ rows: [] }); // last_used stamp
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_fresh' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(request.user?.id).toBe('u9');
    const [shaSql, shaParams] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(shaSql).toContain('key_sha256 = $1');
    expect(shaParams).toEqual(['sha-of-key']);
    expect(cacheFns.cacheApiKey).toHaveBeenCalledWith('cp_fresh', 'key-9', 'u9');
    // Fresh verification always stamps last_used_at.
    expect(mockPoolQuery.mock.calls[1]?.[0]).toContain('last_used_at');
  });

  it('falls back to the legacy bcrypt sweep and backfills the fingerprint', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // sha miss
      .mockResolvedValueOnce({
        rows: [
          { id: 'other', key_hash: 'hash-a', user_id: 'ux' },
          { id: 'legacy-1', key_hash: 'hash-b', user_id: 'u3' },
        ],
      }) // legacy rows
      .mockResolvedValueOnce({ rows: [] }) // backfill UPDATE
      .mockResolvedValueOnce({ rows: [] }); // last_used stamp
    authFns.verifyApiKey.mockImplementation((_key: string, hash: string) =>
      Promise.resolve(hash === 'hash-b')
    );
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_legacy' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(request.user?.id).toBe('u3');
    const backfill = mockPoolQuery.mock.calls[2] as [string, unknown[]];
    expect(backfill[0]).toContain('SET key_sha256 = $1');
    expect(backfill[1]).toEqual(['sha-of-key', 'legacy-1']);
    expect(cacheFns.cacheApiKey).toHaveBeenCalledWith('cp_legacy', 'legacy-1', 'u3');
  });

  it('rejects an unknown cp_ key after both lookup paths miss', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    authFns.verifyApiKey.mockResolvedValue(false);
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_bogus' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload.error?.message).toBe('Invalid token');
  });

  it('rejects a non-JWT non-cp token', async () => {
    const request = fakeRequest({ headers: { authorization: 'Bearer garbage' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('does not fail the request when the last_used_at write fails', async () => {
    cacheFns.getCachedApiKey.mockReturnValue({ id: 'key-1', user_id: 'u2' });
    cacheFns.shouldTouchLastUsed.mockReturnValue(true);
    mockPoolQuery.mockRejectedValueOnce(new Error('db hiccup'));
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_secret' } });
    const reply = fakeReply();

    await authenticate(request, reply);

    expect(reply.sent).toBe(false);
    expect(request.user?.id).toBe('u2');
  });
});

describe('optionalAuth', () => {
  it('passes through silently with no token', async () => {
    const request = fakeRequest({ headers: {} });
    const reply = fakeReply();

    await optionalAuth(request, reply);

    expect(request.user).toBeUndefined();
    expect(reply.sent).toBe(false);
  });

  it('attaches the user for a valid JWT', async () => {
    authFns.verifyToken.mockReturnValue({ userId: 'u1', email: '', role: 'user' });

    const request = fakeRequest();
    await optionalAuth(request, fakeReply());

    expect(request.user?.id).toBe('u1');
  });

  it('attaches the user for a valid API key', async () => {
    cacheFns.getCachedApiKey.mockReturnValue({ id: 'key-1', user_id: 'u2' });
    const request = fakeRequest({ headers: { authorization: 'Bearer cp_secret' } });

    await optionalAuth(request, fakeReply());

    expect(request.user?.id).toBe('u2');
  });

  it('never errors on an invalid token', async () => {
    const request = fakeRequest({ headers: { authorization: 'Bearer nonsense' } });
    const reply = fakeReply();

    await optionalAuth(request, reply);

    expect(request.user).toBeUndefined();
    expect(reply.sent).toBe(false);
  });
});

describe('requireAdmin', () => {
  it('propagates the 401 from authenticate and stops there', async () => {
    const request = fakeRequest({ headers: {} });
    const reply = fakeReply();

    await requireAdmin(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload.error?.message).toBe('Authentication required');
  });

  it('rejects an authenticated non-admin with 403', async () => {
    authFns.verifyToken.mockReturnValue({ userId: 'u1', email: '', role: 'user' });
    const request = fakeRequest();
    const reply = fakeReply();

    await requireAdmin(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload.error?.message).toBe('Admin access required');
  });

  it('lets an admin through', async () => {
    authFns.verifyToken.mockReturnValue({ userId: 'u1', email: '', role: 'admin' });
    const request = fakeRequest();
    const reply = fakeReply();

    await requireAdmin(request, reply);

    expect(reply.sent).toBe(false);
  });
});
