/**
 * Lock the contract for getApiVersion(). Production deploys (DO App
 * Platform, k8s, systemd) launch `node dist/index.js` directly, where
 * `process.env.npm_package_version` is undefined. This test catches
 * regressions to the old `process.env.npm_package_version ?? '0.0.0'`
 * pattern that would silently report v0.0.0 in production.
 */

import { describe, it, expect } from 'vitest';
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

  it('does not depend on process.env.npm_package_version', () => {
    // Production-mode regression check: even with the env var blanked out,
    // we should still get the real version. Without the file-reading
    // version.ts, this would fall through to '0.0.0' — which was exactly
    // the DO-deploy bug.
    const original = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
      expect(getApiVersion()).not.toBe('0.0.0');
    } finally {
      if (original !== undefined) process.env.npm_package_version = original;
    }
  });
});
