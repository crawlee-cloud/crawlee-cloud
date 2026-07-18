/**
 * In-memory cache of successfully verified API keys.
 *
 * validateApiKey compares the presented token against EVERY active key's
 * bcrypt hash (cost 10 ≈ 69ms of main-thread CPU per compare in bcryptjs).
 * Uncached, that puts an O(active-keys) bcrypt sweep on every cp_-key
 * request, which caps ingest at ~7 req/s per instance and pins the event
 * loop — measured as the 2026-07-17 production CPU saturation during
 * scrape waves (dataset pushes averaged 2.9s while the non-auth pipeline
 * costs ~8ms). Caching the verified token→key mapping removes bcrypt from
 * the warm path entirely.
 *
 * Security properties:
 * - Entries are keyed by SHA-256 of the token; the plaintext token is
 *   never retained.
 * - An entry is only ever created after a successful bcrypt verification;
 *   failed verifies are never cached, so brute-force cost is unchanged.
 * - Revoking a key evicts it from the local replica immediately (see
 *   invalidateApiKey); other replicas converge within the TTL, so the
 *   TTL is the upper bound on cross-replica revocation lag.
 */

import { createHash } from 'node:crypto';

interface CacheEntry {
  apiKeyId: string;
  userId: string;
  /** ms epoch of the last successful bcrypt verification */
  verifiedAt: number;
  /** ms epoch of the last last_used_at DB write for this key */
  lastTouchAt: number;
}

// Only successful verifications are cached, so the natural size bound is
// the number of active API keys. The cap is a hygiene backstop, evicting
// the oldest entry (Map preserves insertion order) if it is ever hit.
const MAX_ENTRIES = 10_000;

const entries = new Map<string, CacheEntry>();

let ttlMs = readTtlMsFromEnv();

function readTtlMsFromEnv(): number {
  const secs = Number(process.env.API_KEY_CACHE_TTL_SECS ?? 300);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Override cache settings. ttlSecs <= 0 disables caching (every request
 * falls through to the bcrypt sweep, matching pre-cache behavior).
 */
export function configureApiKeyCache(options: { ttlSecs: number }): void {
  ttlMs = options.ttlSecs > 0 ? options.ttlSecs * 1000 : 0;
}

/** Drop every cached entry (tests, or operational panic switch). */
export function clearApiKeyCache(): void {
  entries.clear();
}

/**
 * Return the cached identity for a token, or null when disabled, unknown,
 * or expired. Expired entries are deleted so the map only holds live ones.
 */
export function getCachedApiKey(token: string): { id: string; user_id: string } | null {
  if (ttlMs === 0) return null;

  const key = fingerprint(token);
  const entry = entries.get(key);
  if (!entry) return null;

  if (Date.now() - entry.verifiedAt >= ttlMs) {
    entries.delete(key);
    return null;
  }

  return { id: entry.apiKeyId, user_id: entry.userId };
}

/** Record a successful verification. No-op while the cache is disabled. */
export function cacheApiKey(token: string, apiKeyId: string, userId: string): void {
  if (ttlMs === 0) return;

  const key = fingerprint(token);
  // Refreshing an existing entry doesn't grow the map — only evict when
  // a genuinely new entry would push past the cap.
  if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  const now = Date.now();
  entries.set(key, {
    apiKeyId,
    userId,
    verifiedAt: now,
    lastTouchAt: now,
  });
}

/**
 * Whether this request should write last_used_at. True at most once per
 * TTL window per key — the write is bookkeeping, not security, and at
 * ingest rates an unconditional write is one extra DB round-trip per
 * request. Always true while the cache is disabled (previous behavior).
 */
export function shouldTouchLastUsed(token: string): boolean {
  if (ttlMs === 0) return true;

  const entry = entries.get(fingerprint(token));
  if (!entry) return true;

  const now = Date.now();
  if (now - entry.lastTouchAt >= ttlMs) {
    entry.lastTouchAt = now;
    return true;
  }
  return false;
}

/**
 * Evict a key by its DB id (called when a key is revoked). Linear scan is
 * fine: the map holds at most one entry per active key.
 */
export function invalidateApiKey(apiKeyId: string): void {
  for (const [mapKey, entry] of entries) {
    if (entry.apiKeyId === apiKeyId) {
      entries.delete(mapKey);
    }
  }
}
