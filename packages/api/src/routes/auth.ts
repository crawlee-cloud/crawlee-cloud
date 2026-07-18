/**
 * Authentication routes.
 *
 * POST /v2/auth/register - Create new user
 * POST /v2/auth/login - Login and get token
 * POST /v2/auth/api-keys - Create API key
 * GET /v2/auth/api-keys - List API keys
 * DELETE /v2/auth/api-keys/:id - Revoke API key
 * GET /v2/auth/me - Get current user info
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { pool } from '../db/index.js';
import {
  verifyPassword,
  createToken,
  generateApiKey,
  hashApiKey,
  sha256ApiKey,
} from '../auth/index.js';
import { authenticate } from '../auth/middleware.js';
import { invalidateApiKey } from '../auth/api-key-cache.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const apiKeySchema = z.object({
  name: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  // Registration is disabled - admin user is created from env vars on startup
  // Users can be invited by admin (future feature)

  /**
   * Login and get JWT token.
   */
  app.post('/v2/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const result = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      name: string | null;
      role: string;
    }>('SELECT id, email, password_hash, name, role FROM users WHERE email = $1', [body.email]);

    const user = result.rows[0];
    if (!user) {
      return reply.status(401).send({ error: { message: 'Invalid credentials' } });
    }

    const isValid = await verifyPassword(body.password, user.password_hash);

    if (!isValid) {
      return reply.status(401).send({ error: { message: 'Invalid credentials' } });
    }

    const token = createToken({
      userId: user.id,
      email: user.email,
      role: user.role as 'admin' | 'user',
    });

    return reply.send({
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token,
      },
    });
  });

  // Authenticated routes — wrapped in an encapsulated plugin so the
  // preHandler hook applies to all routes here and avoids per-route
  // `{ preHandler: authenticate }` (which trips no-misused-promises
  // because Fastify's route-option type expects a sync hook).
  await app.register(async (instance) => {
    instance.addHook('preHandler', authenticate);

    /**
     * Get current user info.
     */
    instance.get('/v2/auth/me', async (request, reply) => {
      const user = request.user;
      if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });

      const result = await pool.query<{
        id: string;
        email: string;
        name: string | null;
        role: string;
        created_at: Date;
      }>('SELECT id, email, name, role, created_at FROM users WHERE id = $1', [user.id]);

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: { message: 'User not found' } });
      }

      return reply.send({ data: result.rows[0] });
    });

    /**
     * Create a new API key.
     */
    instance.post('/v2/auth/api-keys', async (request, reply) => {
      const user = request.user;
      if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });

      const body = apiKeySchema.parse(request.body);

      const keyId = nanoid();
      const rawKey = generateApiKey();
      const keyHash = await hashApiKey(rawKey);

      await pool.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_sha256, key_preview, created_at, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), true)`,
        [keyId, user.id, body.name, keyHash, sha256ApiKey(rawKey), rawKey.slice(0, 12) + '...']
      );

      // Return the raw key only once - it can't be retrieved again
      return reply.status(201).send({
        data: {
          id: keyId,
          name: body.name,
          key: rawKey,
          message: 'Save this key - it will not be shown again',
        },
      });
    });

    /**
     * List user's API keys.
     */
    instance.get('/v2/auth/api-keys', async (request, reply) => {
      const user = request.user;
      if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });

      const result = await pool.query<{
        id: string;
        name: string;
        key_preview: string;
        created_at: Date;
        last_used_at: Date | null;
        is_active: boolean;
      }>(
        `SELECT id, name, key_preview, created_at, last_used_at, is_active
         FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
        [user.id]
      );

      // Convert PG snake_case columns to camelCase on the wire — the rest of
      // the API already does this (defaultDatasetId, etc.), and the dashboard's
      // ApiKey interface expects isActive/keyPreview/createdAt/lastUsedAt.
      // Returning raw rows here meant `apiKeys.filter(k => k.isActive)` was
      // always empty, hiding every active key.
      const data = result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        keyPreview: r.key_preview,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        isActive: r.is_active,
      }));

      return reply.send({ data });
    });

    /**
     * Revoke an API key.
     */
    instance.delete('/v2/auth/api-keys/:keyId', async (request, reply) => {
      const user = request.user;
      if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });

      const { keyId } = request.params as { keyId: string };

      const result = await pool.query(
        'UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING id',
        [keyId, user.id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: { message: 'API key not found' } });
      }

      // Evict from this replica's auth cache immediately; other replicas
      // converge within API_KEY_CACHE_TTL_SECS (see api-key-cache.ts).
      invalidateApiKey(keyId);

      return reply.send({ data: { message: 'API key revoked' } });
    });
  });
}
