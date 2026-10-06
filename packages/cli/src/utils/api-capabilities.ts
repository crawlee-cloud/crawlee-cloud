/**
 * Server capability detection.
 *
 * The CLI may be newer than the API it talks to, so request shapes that an
 * older API would misread are gated on the version `GET /health` reports.
 */

import type { CLIConfig } from './config.js';

/**
 * First API release that accepts the Apify run-start contract (raw input
 * body, options in the query string) — #115. Older APIs read the request
 * body as the legacy wrapper `{ input, timeout, memory, envVars }`, so an
 * Apify-shaped body would be misread there. Prereleases of this version
 * (`1.7.0-rc.1`, ...) are cut after #115 and count as supporting it.
 */
export const MIN_APIFY_RUN_BODY_VERSION = '1.7.0';

/** Forces the run-start shape, bypassing the gate (e.g. against unreleased `main`). */
export const RUN_BODY_ENV = 'CRAWLEE_CLOUD_RUN_BODY';

export type RunBodyShape = 'apify' | 'legacy';

const HEALTH_TIMEOUT_MS = 5000;

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build`; anything else → null. */
export function parseSemver(version: unknown): SemVer | null {
  if (typeof version !== 'string') return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  // Numeric identifiers sort below alphanumeric ones (semver §11.4.3).
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: -1, 0 or 1. Build metadata is ignored. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A version without prerelease outranks any prerelease of it.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdentifiers(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * True when an API reporting `version` accepts the Apify run-start body.
 * Compares against `<MIN>-0`, the lowest prerelease of the minimum version,
 * so `1.7.0-rc.1` passes while `1.6.9` does not. Missing or unparseable
 * versions fail the gate (legacy is the shape every API version accepts).
 */
export function supportsApifyRunBody(version: unknown): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const min = parseSemver(`${MIN_APIFY_RUN_BODY_VERSION}-0`)!;
  return compareSemver(parsed, min) >= 0;
}

/** Reads the `CRAWLEE_CLOUD_RUN_BODY` override; unknown values are ignored. */
function runBodyOverride(): RunBodyShape | undefined {
  const raw = process.env[RUN_BODY_ENV]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'apify' || raw === 'legacy') return raw;
  console.warn(`Ignoring ${RUN_BODY_ENV}=${raw} (expected "apify" or "legacy").`);
  return undefined;
}

async function detectRunBodyShape(apiBaseUrl: string): Promise<RunBodyShape> {
  try {
    const res = await fetch(`${apiBaseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return 'legacy';
    const body = (await res.json()) as { version?: unknown };
    return supportsApifyRunBody(body?.version) ? 'apify' : 'legacy';
  } catch {
    return 'legacy';
  }
}

// Per-process cache, keyed by API URL (a single invocation talks to one
// profile, but tests and library callers may switch).
const shapeCache = new Map<string, Promise<RunBodyShape>>();

/**
 * Which run-start request shape to send to this API. The env override
 * wins; otherwise `GET /health` is probed once per process and API URL.
 */
export function getRunBodyShape(config: Pick<CLIConfig, 'apiBaseUrl'>): Promise<RunBodyShape> {
  const override = runBodyOverride();
  if (override) return Promise.resolve(override);

  let cached = shapeCache.get(config.apiBaseUrl);
  if (!cached) {
    cached = detectRunBodyShape(config.apiBaseUrl);
    shapeCache.set(config.apiBaseUrl, cached);
  }
  return cached;
}

/** Test hook: forget probed shapes. */
export function resetApiCapabilitiesCache(): void {
  shapeCache.clear();
}
