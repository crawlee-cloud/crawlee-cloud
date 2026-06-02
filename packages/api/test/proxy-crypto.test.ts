import { describe, it, expect, beforeEach } from 'vitest';

// 64 hex chars = 32 bytes
const TEST_KEY = 'a'.repeat(64);

describe('proxy-crypto', () => {
  beforeEach(() => {
    process.env.PROXY_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.API_SECRET;
  });

  it('encrypts then decrypts round-trips the plaintext', async () => {
    const { encryptProxyPassword, decryptProxyPassword } =
      await import('../src/lib/proxy-crypto.js');
    const plain = 'apify_proxy_password_123';
    const stored = encryptProxyPassword(plain);
    expect(decryptProxyPassword(stored)).toBe(plain);
  });

  it('stored format starts with v1: prefix', async () => {
    const { encryptProxyPassword } = await import('../src/lib/proxy-crypto.js');
    const stored = encryptProxyPassword('whatever');
    expect(stored).toMatch(/^v1:/);
  });

  it('encrypting the same plaintext twice yields different ciphertexts (IV uniqueness)', async () => {
    const { encryptProxyPassword } = await import('../src/lib/proxy-crypto.js');
    const a = encryptProxyPassword('same-input');
    const b = encryptProxyPassword('same-input');
    expect(a).not.toBe(b);
  });

  it('decrypt with wrong key throws', async () => {
    const { encryptProxyPassword, decryptProxyPassword } =
      await import('../src/lib/proxy-crypto.js');
    const stored = encryptProxyPassword('secret');
    process.env.PROXY_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(() => decryptProxyPassword(stored)).toThrow();
  });

  it('decrypt with corrupted auth tag throws', async () => {
    const { encryptProxyPassword, decryptProxyPassword } =
      await import('../src/lib/proxy-crypto.js');
    const stored = encryptProxyPassword('secret');
    // Corrupt the first char of the auth-tag segment (avoids base64 padding issues)
    const parts = stored.split(':');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    const corrupted = parts.join(':');
    expect(() => decryptProxyPassword(corrupted)).toThrow();
  });

  it('decrypt with malformed input throws', async () => {
    const { decryptProxyPassword } = await import('../src/lib/proxy-crypto.js');
    expect(() => decryptProxyPassword('not-a-valid-format')).toThrow(/format/);
    expect(() => decryptProxyPassword('v2:a:b:c')).toThrow(/format/);
  });

  it('encrypt throws when no key is configured', async () => {
    delete process.env.PROXY_ENCRYPTION_KEY;
    delete process.env.API_SECRET;
    const { encryptProxyPassword } = await import('../src/lib/proxy-crypto.js');
    expect(() => encryptProxyPassword('x')).toThrow(/PROXY_ENCRYPTION_KEY|API_SECRET/);
  });

  it('falls back to sha256(API_SECRET) when PROXY_ENCRYPTION_KEY is unset', async () => {
    delete process.env.PROXY_ENCRYPTION_KEY;
    process.env.API_SECRET = 'dev-secret-for-tests';
    const { encryptProxyPassword, decryptProxyPassword } =
      await import('../src/lib/proxy-crypto.js');
    const plain = 'pw';
    const stored = encryptProxyPassword(plain);
    expect(decryptProxyPassword(stored)).toBe(plain);
  });

  it('rejects a 64-char non-hex key (would silently truncate via Buffer.from hex)', async () => {
    // 64-char string but contains non-hex characters; Buffer.from(_, 'hex')
    // stops at the first non-hex char and yields < 32 bytes. The getKey()
    // decode-and-check guard must catch this.
    process.env.PROXY_ENCRYPTION_KEY = 'z'.repeat(64);
    const { encryptProxyPassword } = await import('../src/lib/proxy-crypto.js');
    expect(() => encryptProxyPassword('x')).toThrow(/valid 64-character hex string/);
  });
});
