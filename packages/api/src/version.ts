/**
 * Resolves the API package version at runtime.
 *
 * `process.env.npm_package_version` is only set by `npm run *` invocations.
 * Production deploys typically launch `node dist/index.js` directly (DO App
 * Platform, k8s containers, systemd units), where that env var is undefined
 * — falling through to a hardcoded `0.0.0` was misleading on the dashboard
 * and broke `/health`'s version field.
 *
 * The disk read happens **at module load time** (the IIFE below) rather
 * than lazily on first call. Reasons:
 *   - `getApiVersion()` is called from request handlers like `/health`. A
 *     lazy read would block the event loop on the first request after
 *     boot, which is exactly when load balancers / orchestrators are most
 *     likely to be probing.
 *   - The value can't change at runtime — there's no scenario where
 *     re-reading `package.json` mid-process is useful.
 *   - Pulling I/O to load time also makes a startup failure (missing
 *     package.json, malformed JSON) visible immediately rather than on
 *     the first qualified request, which is easier to diagnose.
 *
 * The compiled file lives at `dist/version.js`; `package.json` is one
 * level up. The IIFE catches its own errors so a missing/malformed
 * package.json can't break module load.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → ../package.json. Layout assumption: tsc emits to
    // `dist/` with `rootDir: src`, which is the project's tsconfig today.
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // package.json missing / unreadable / malformed JSON. Don't crash
    // the server — fall back to a sentinel that operators can spot.
    return '0.0.0';
  }
})();

export function getApiVersion(): string {
  return VERSION;
}
