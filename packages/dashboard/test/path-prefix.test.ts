/**
 * Tests for the reverse-proxy route prefix helper. ROUTE_PREFIX is
 * captured from the env at import time, so each case re-imports the
 * module with vi.resetModules() after setting NEXT_PUBLIC_ROUTE_PREFIX.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const ORIGINAL = process.env.NEXT_PUBLIC_ROUTE_PREFIX;

async function importWithPrefix(prefix: string | undefined) {
  if (prefix === undefined) delete process.env.NEXT_PUBLIC_ROUTE_PREFIX;
  else process.env.NEXT_PUBLIC_ROUTE_PREFIX = prefix;
  vi.resetModules();
  return import('@/lib/path-prefix');
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_ROUTE_PREFIX;
  else process.env.NEXT_PUBLIC_ROUTE_PREFIX = ORIGINAL;
});

describe('prefixPath', () => {
  it('is a no-op when no prefix is configured', async () => {
    const { prefixPath, ROUTE_PREFIX } = await importWithPrefix(undefined);
    expect(ROUTE_PREFIX).toBe('');
    expect(prefixPath('/runs')).toBe('/runs');
  });

  it('prepends the configured prefix', async () => {
    const { prefixPath } = await importWithPrefix('/dashboard');
    expect(prefixPath('/runs')).toBe('/dashboard/runs');
  });

  it('does not double-prefix an already-prefixed path', async () => {
    const { prefixPath } = await importWithPrefix('/dashboard');
    expect(prefixPath('/dashboard/runs')).toBe('/dashboard/runs');
  });
});
