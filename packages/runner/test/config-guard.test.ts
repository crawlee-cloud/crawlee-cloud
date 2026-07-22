/**
 * Tests for the PROXY_ENCRYPTION_KEY startup validation in config.ts.
 * The guard runs at import time and calls process.exit(1), so each case
 * re-imports a fresh module with vi.resetModules() and a stubbed
 * process.exit — the same pattern proxy-resolver.test.ts uses for
 * env-driven config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as unknown as typeof process.exit);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe('PROXY_ENCRYPTION_KEY startup guard', () => {
  it('exits fatally in production when the key is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PROXY_ENCRYPTION_KEY;

    await import('../src/config.js');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('FATAL: PROXY_ENCRYPTION_KEY is not set in production');
  });

  it('exits fatally when the key is not 64 hex characters', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PROXY_ENCRYPTION_KEY = 'not-hex-and-way-too-short';

    await import('../src/config.js');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('must be exactly 64 hex characters');
  });

  it('rejects a 64-char key containing non-hex characters', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PROXY_ENCRYPTION_KEY = 'g'.repeat(64); // right length, wrong alphabet

    await import('../src/config.js');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts a valid 64-hex key without exiting', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PROXY_ENCRYPTION_KEY = 'ab'.repeat(32);

    const { config } = await import('../src/config.js');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.apiBaseUrl).toBeDefined();
  });

  it('allows a missing key outside production (dev fallback path)', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PROXY_ENCRYPTION_KEY;

    await import('../src/config.js');

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
