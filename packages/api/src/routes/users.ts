/**
 * Users routes — Apify-compatible endpoints for user info.
 *
 * /v2/users/me is dual-purpose:
 *   - Apify SDK fallback when APIFY_PROXY_PASSWORD env is unset → reads
 *     `data.proxy.password` to construct the proxy URL.
 *   - Dashboard "who am I + what's my proxy state" probe.
 *
 * Auth is optional (preserves the long-standing "no token → anonymous"
 * behavior for unauthed callers).
 *
 * TODO: when [[project_runner_auth_bug]] is fixed (runner API key bound
 * to admin), this endpoint will start resolving to the *actor's owner*
 * for SDK fallback calls. Until then, the SDK fallback path resolves to
 * whichever user the runner key is bound to — usually the admin. The
 * env-injection path always takes precedence and is unaffected.
 */

import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { pool } from '../db/index.js';
import { optionalAuth, authenticate } from '../auth/middleware.js';
import { decryptProxyPassword, encryptProxyPassword } from '../lib/proxy-crypto.js';
import { UpdateUserSchema } from '../schemas/users.js';

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    // PUT requires auth; GET is optional.
    if (request.method === 'GET') {
      await optionalAuth(request, reply);
    } else {
      await authenticate(request, reply);
    }
  });

  /**
   * GET /v2/users/me — Apify-compatible.
   */
  fastify.get('/users/me', async (request) => {
    if (!request.user) {
      return {
        data: {
          id: 'anonymous',
          username: 'anonymous',
          profile: {},
          isPaidUser: false,
          plan: 'FREE',
        },
      };
    }

    const row = await pool.query<{ email: string; proxy_password_encrypted: string | null }>(
      'SELECT email, proxy_password_encrypted FROM users WHERE id = $1',
      [request.user.id]
    );
    const u = row.rows[0];

    const data: Record<string, unknown> = {
      id: request.user.id,
      username: u?.email ?? '',
      profile: {},
      isPaidUser: false,
      plan: 'FREE',
    };

    // Apify SDK's UserProxy.password is non-nullable. When no password
    // is configured, omit the proxy field entirely rather than sending
    // a null that would type-violate the client.
    //
    // Decrypt is fallible after a key rotation or a corrupted row. Don't
    // 500 the SDK fallback / dashboard probe over it — log server-side
    // and omit the proxy field so the caller treats this user as "no
    // proxy configured" until the row is repaired.
    if (u?.proxy_password_encrypted) {
      try {
        data.proxy = {
          password: decryptProxyPassword(u.proxy_password_encrypted),
          groups: [],
        };
      } catch (err) {
        fastify.log.error(
          { err, userId: request.user.id },
          'Failed to decrypt user proxy_password_encrypted; omitting proxy from response'
        );
      }
    }

    return { data };
  });

  /**
   * GET /v2/users/me/limits — Apify-compatible.
   */
  fastify.get('/users/me/limits', async () => {
    return {
      data: {
        maxConcurrentRuns: 100,
        maxMemoryMbytes: 32768,
      },
    };
  });

  /**
   * PUT /v2/users/me — Update the authed user's proxy password.
   */
  fastify.put<{ Body: { proxyPassword?: string | null } }>('/users/me', async (request, reply) => {
    if (!request.user) {
      reply.status(401);
      return { error: { message: 'Authentication required' } };
    }
    let body: ReturnType<typeof UpdateUserSchema.parse>;
    try {
      body = UpdateUserSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400);
        return { error: { message: err.message } };
      }
      throw err;
    }

    let hasProxyPassword = false;
    if (body.proxyPassword !== undefined) {
      const stored = body.proxyPassword === null ? null : encryptProxyPassword(body.proxyPassword);
      await pool.query(
        'UPDATE users SET proxy_password_encrypted = $1, modified_at = NOW() WHERE id = $2',
        [stored, request.user.id]
      );
      hasProxyPassword = body.proxyPassword !== null;
    } else {
      const row = await pool.query<{ proxy_password_encrypted: string | null }>(
        'SELECT proxy_password_encrypted FROM users WHERE id = $1',
        [request.user.id]
      );
      hasProxyPassword = row.rows[0]?.proxy_password_encrypted != null;
    }

    return { data: { id: request.user.id, hasProxyPassword } };
  });
};
