/**
 * Resolves the API package version at runtime.
 *
 * `process.env.npm_package_version` is only set by `npm run *` invocations.
 * Production deploys typically launch `node dist/index.js` directly (DO App
 * Platform, k8s containers, systemd units), where that env var is undefined
 * — falling through to a hardcoded `0.0.0` was misleading on the dashboard
 * and broke `/health`'s version field.
 *
 * Read `package.json` from disk once at module load. The compiled file
 * lives at `dist/version.js`; `package.json` is one level up. Cached after
 * first read because Node's require/import cycle keeps the module loaded
 * for the lifetime of the process anyway, but explicit caching makes the
 * intent clear.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function getApiVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → ../package.json. Layout assumption: tsc emits to
    // `dist/` with `rootDir: src`, which is the project's tsconfig today.
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    // package.json missing / unreadable / malformed JSON. Don't crash
    // the server — fall back to a sentinel that operators can spot.
    cached = '0.0.0';
  }
  return cached;
}
