import { describe, it, expect, beforeEach, vi } from 'vitest';

// Required by proxy-crypto at import time
process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);

// Reset runner config module's view of env vars between tests
const setConfigEnv = (overrides: Record<string, string>) => {
  Object.assign(process.env, overrides);
};

describe('resolveProxy', () => {
  beforeEach(() => {
    delete process.env.APIFY_PROXY_PASSWORD;
    delete process.env.APIFY_PROXY_HOSTNAME;
    delete process.env.APIFY_PROXY_PORT;
    vi.resetModules();
  });

  async function freshImports() {
    const crypto = await import('../src/proxy-crypto.js');
    const resolver = await import('../src/proxy-resolver.js');
    return { ...crypto, ...resolver };
  }

  it('returns source=actor when actor override is set', async () => {
    const { encryptProxyPassword, resolveProxy } = await freshImports();
    const fakePool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ proxy_password_encrypted: encryptProxyPassword('actor-pw') }],
      }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.source).toBe('actor');
    expect(result.password).toBe('actor-pw');
  });

  it('returns source=user when user has password and actor does not', async () => {
    const { encryptProxyPassword, resolveProxy } = await freshImports();
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }) // actor
        .mockResolvedValueOnce({
          rows: [{ proxy_password_encrypted: encryptProxyPassword('user-pw') }],
        }), // user
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.source).toBe('user');
    expect(result.password).toBe('user-pw');
  });

  it('returns source=platform when only env is set', async () => {
    setConfigEnv({ APIFY_PROXY_PASSWORD: 'platform-pw' });
    const { resolveProxy } = await freshImports();
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] })
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.source).toBe('platform');
    expect(result.password).toBe('platform-pw');
  });

  it('returns source=none when nothing is configured', async () => {
    const { resolveProxy } = await freshImports();
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] })
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.source).toBe('none');
    expect(result.password).toBeNull();
  });

  it('returns null hostname/port when config defaults are empty', async () => {
    setConfigEnv({ APIFY_PROXY_PASSWORD: 'platform-pw' });
    const { resolveProxy } = await freshImports();
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] })
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.hostname).toBeNull();
    expect(result.port).toBeNull();
  });

  it('handles null userId — skips user lookup', async () => {
    const { resolveProxy } = await freshImports();
    const fakePool = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', null);
    expect(result.source).toBe('none');
    expect(fakePool.query).toHaveBeenCalledTimes(1); // only the actor query
  });

  it('skips an undecryptable tier and falls through (does not throw)', async () => {
    // Encrypt with one key, then change the env key so decrypt fails.
    process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);
    const { encryptProxyPassword } = await import('../src/proxy-crypto.js');
    const corruptedForCurrentKey = encryptProxyPassword('actor-pw');
    process.env.PROXY_ENCRYPTION_KEY = 'b'.repeat(64);
    setConfigEnv({ APIFY_PROXY_PASSWORD: 'platform-pw' });
    const { resolveProxy } = await freshImports();
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: corruptedForCurrentKey }] })
        .mockResolvedValueOnce({ rows: [{ proxy_password_encrypted: null }] }),
    };
    const result = await resolveProxy(fakePool as never, 'actor-1', 'user-1');
    expect(result.source).toBe('platform');
    expect(result.password).toBe('platform-pw');
  });
});
