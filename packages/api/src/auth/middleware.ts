/**
 * Authentication middleware for Fastify routes.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/index.js';
import { extractToken, verifyToken, verifyApiKey, sha256ApiKey } from './index.js';
import { getCachedApiKey, cacheApiKey, shouldTouchLastUsed } from './api-key-cache.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authentication middleware.
 * Validates JWT tokens or API keys.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Token from Authorization header is the primary path. As a fallback we
  // also accept ?token= in the query string so the dashboard can open
  // download endpoints (raw logs, dataset JSON, presigned record URLs)
  // directly in a new tab — browsers can't add custom headers to a plain
  // <a target="_blank"> click. Tokens in URLs are slightly riskier (server
  // logs, referrer headers), bounded here by the existing JWT TTL.
  // TODO: replace with short-lived single-use download tokens once we have a
  // real shared-operator deployment.
  const headerToken = extractToken(request.headers.authorization);
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  const token = headerToken ?? (typeof queryToken === 'string' ? queryToken : null);

  if (!token) {
    reply.status(401).send({ error: { message: 'Authentication required' } });
    return;
  }

  // Try JWT token first
  const jwtPayload = verifyToken(token);
  if (jwtPayload) {
    request.user = {
      id: jwtPayload.userId,
      email: jwtPayload.email || '',
      role: jwtPayload.role,
    };
    return;
  }

  // Try API key
  if (token.startsWith('cp_')) {
    const apiKey = await validateApiKey(token);
    if (apiKey) {
      request.user = {
        id: apiKey.user_id,
        email: '',
        role: 'user',
      };

      // last_used_at is bookkeeping, not security — write it on every
      // fresh verification but at most once per cache-TTL window on the
      // warm path, so ingest traffic doesn't pay a DB write per request.
      // A failed write must not fail an already-authenticated request.
      if (!apiKey.cached || shouldTouchLastUsed(token)) {
        try {
          await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [apiKey.id]);
        } catch (err) {
          request.log?.error({ err, apiKeyId: apiKey.id }, 'Failed to update last_used_at');
        }
      }
      return;
    }
  }

  reply.status(401).send({ error: { message: 'Invalid token' } });
}

/**
 * Optional authentication - doesn't fail if no token.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractToken(request.headers.authorization);

  if (!token) return;

  const jwtPayload = verifyToken(token);
  if (jwtPayload) {
    request.user = {
      id: jwtPayload.userId,
      email: jwtPayload.email || '',
      role: jwtPayload.role,
    };
    return;
  }

  if (token.startsWith('cp_')) {
    const apiKey = await validateApiKey(token);
    if (apiKey) {
      request.user = {
        id: apiKey.user_id,
        email: '',
        role: 'user',
      };
    }
  }
}

/**
 * Admin-only middleware.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);

  if (reply.sent) return;

  if (request.user?.role !== 'admin') {
    reply.status(403).send({ error: { message: 'Admin access required' } });
  }
}

/**
 * Validate an API key against the database.
 *
 * The bcrypt sweep below costs ~69ms of main-thread CPU per active key
 * row (bcryptjs cost 10), which uncached capped the api at ~7 ingest
 * req/s per instance and caused the 2026-07-17 scrape-wave CPU
 * saturation. The cache (see api-key-cache.ts) makes the warm path
 * bcrypt-free; `cached` tells the caller whether this was a fresh
 * verification (which should also stamp last_used_at).
 */
async function validateApiKey(
  key: string
): Promise<{ id: string; user_id: string; cached: boolean } | null> {
  const cached = getCachedApiKey(key);
  if (cached) {
    return { id: cached.id, user_id: cached.user_id, cached: true };
  }

  // O(1) indexed lookup by SHA-256 fingerprint — the normal cold path.
  // A sha match is proof of key knowledge (see sha256ApiKey), so no
  // bcrypt work is needed, and unknown/attacker keys are rejected in
  // one index probe instead of an O(active-keys) bcrypt sweep.
  const sha = sha256ApiKey(key);
  const bySha = await pool.query<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM api_keys WHERE key_sha256 = $1 AND is_active = true',
    [sha]
  );
  const shaRow = bySha.rows[0];
  if (shaRow) {
    cacheApiKey(key, shaRow.id, shaRow.user_id);
    return { id: shaRow.id, user_id: shaRow.user_id, cached: false };
  }

  // Legacy rows created before key_sha256 existed: bcrypt sweep, then
  // backfill the fingerprint so each legacy key pays this exactly once.
  // Once every active row is backfilled this query returns nothing and
  // invalid keys cost zero bcrypt compares.
  const result = await pool.query<{ id: string; key_hash: string; user_id: string }>(
    'SELECT id, key_hash, user_id FROM api_keys WHERE is_active = true AND key_sha256 IS NULL'
  );

  for (const row of result.rows) {
    const isValid = await verifyApiKey(key, row.key_hash);
    if (isValid) {
      await pool.query('UPDATE api_keys SET key_sha256 = $1 WHERE id = $2', [sha, row.id]);
      cacheApiKey(key, row.id, row.user_id);
      return { id: row.id, user_id: row.user_id, cached: false };
    }
  }

  return null;
}
