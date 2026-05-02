/**
 * Lock the contract for getApiVersion(). Production deploys (DO App
 * Platform, k8s, systemd) launch `node dist/index.js` directly, where
 * `process.env.npm_package_version` is undefined. This test catches
 * regressions to the old `process.env.npm_package_version ?? '0.0.0'`
 * pattern that would silently report v0.0.0 in production.
 *
 * Because the version helper reads package.json **at module load time**
 * and caches the result for the process lifetime, the env-var-deletion
 * test below must use `vi.resetModules()` + dynamic import to force a
 * fresh module load with the modified env. Without that, both tests
 * here would observe the same cached value populated by whichever ran
 * first — and the regression assertion would be vacuous.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getApiVersion } from '../src/version.js';

describe('getApiVersion', () => {
  it("returns the api package.json version, not the '0.0.0' fallback", () => {
    // Read package.json the same way version.ts does, directly from disk,
    // so this test fails loudly if the helper diverges from reality (e.g.
    // someone hardcodes a version, or the path math breaks after a tsc
    // outDir change).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const expected = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

    const actual = getApiVersion();
    expect(actual).toBe(expected);
    expect(actual).not.toBe('0.0.0'); // belt-and-suspenders against the regression
  });

  it('does not depend on process.env.npm_package_version', async () => {
    // Production-mode regression check: even with the env var blanked out,
    // we should still get the real version. version.ts caches at module
    // load, so we MUST reset modules + re-import inside this test for the
    // env mutation to actually exercise the load-time codepath. Without
    // resetModules() this assertion would just be re-checking the value
    // cached by the previous test — vacuous.
    const original = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
      vi.resetModules();
      const fresh = (await import('../src/version.js')) as { getApiVersion: () => string };
      expect(fresh.getApiVersion()).not.toBe('0.0.0');
    } finally {
      if (original !== undefined) process.env.npm_package_version = original;
    }
  });
});
