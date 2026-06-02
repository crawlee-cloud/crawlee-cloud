import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

// 64 hex chars; required by proxy-crypto helper at module load
process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);

// Mock auth — populate request.user when token header is "valid-token"
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (
    request: {
      user?: { id: string; email: string; role: string };
      headers: { authorization?: string };
    },
    reply: { status: (n: number) => { send: (b: unknown) => void } }
  ) => {
    if (request.headers.authorization === 'Bearer valid-token') {
      request.user = { id: 'user-1', email: '', role: 'user' };
    } else {
      reply.status(401).send({ error: { message: 'unauth' } });
    }
  },
  optionalAuth: async (request: {
    user?: { id: string; email: string; role: string };
    headers: { authorization?: string };
  }) => {
    if (request.headers.authorization === 'Bearer valid-token') {
      request.user = { id: 'user-1', email: '', role: 'user' };
    }
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { usersRoutes } from '../src/routes/users.js';
import { encryptProxyPassword } from '../src/lib/proxy-crypto.js';

describe('Users routes — GET /v2/users/me', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(usersRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns anonymous when not authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/users/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.id).toBe('anonymous');
    expect(body.data.proxy).toBeUndefined();
  });

  it('returns no proxy field when authed user has no password set', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ email: 'a@b.com', proxy_password_encrypted: null }],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.id).toBe('user-1');
    expect(body.data.username).toBe('a@b.com');
    expect(body.data.proxy).toBeUndefined();
  });

  it('returns proxy.password (decrypted) when authed user has it set', async () => {
    const stored = encryptProxyPassword('apify_pw_xyz');
    mockQuery.mockResolvedValueOnce({
      rows: [{ email: 'a@b.com', proxy_password_encrypted: stored }],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
    });
    const body = res.json();
    expect(body.data.proxy).toEqual({
      password: 'apify_pw_xyz',
      groups: [],
    });
  });
});

describe('Users routes — PUT /v2/users/me', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(usersRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v2/users/me', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('stores encrypted blob (not plaintext) on set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
      payload: { proxyPassword: 'plain-password-xyz' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET proxy_password_encrypted'),
      expect.arrayContaining([expect.stringMatching(/^v1:/), 'user-1'])
    );
    // Make sure plaintext NEVER appears in the call args.
    const args = mockQuery.mock.calls[0][1] as unknown[];
    expect(args).not.toContain('plain-password-xyz');
  });

  it('clears column on proxyPassword: null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
      payload: { proxyPassword: null },
    });
    expect(res.statusCode).toBe(200);
    const args = mockQuery.mock.calls[0][1] as unknown[];
    expect(args[0]).toBeNull();
  });

  it('rejects overlong proxy password with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
      payload: { proxyPassword: 'x'.repeat(300) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns hasProxyPassword=true after setting a value', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/users/me',
      headers: { authorization: 'Bearer valid-token' },
      payload: { proxyPassword: 'abc' },
    });
    expect(res.json().data.hasProxyPassword).toBe(true);
  });
});
