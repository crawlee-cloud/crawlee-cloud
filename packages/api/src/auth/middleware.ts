/**
 * Authentication middleware for Fastify routes.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/index.js';
import { extractToken, verifyToken, verifyApiKey } from './index.js';

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
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = extractToken(request.headers.authorization);
  
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
      
      // Update last used timestamp
      await pool.query(
        'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
        [apiKey.id]
      );
      return;
    }
  }
  
  reply.status(401).send({ error: { message: 'Invalid token' } });
}

/**
 * Optional authentication - doesn't fail if no token.
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
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
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authenticate(request, reply);
  
  if (reply.sent) return;
  
  if (request.user?.role !== 'admin') {
    reply.status(403).send({ error: { message: 'Admin access required' } });
  }
}

/**
 * Validate an API key against the database.
 */
async function validateApiKey(key: string): Promise<{ id: string; user_id: string } | null> {
  // Get all API keys and check against hash
  const result = await pool.query<{ id: string; key_hash: string; user_id: string }>(
    'SELECT id, key_hash, user_id FROM api_keys WHERE is_active = true'
  );
  
  for (const row of result.rows) {
    const isValid = await verifyApiKey(key, row.key_hash);
    if (isValid) {
      return { id: row.id, user_id: row.user_id };
    }
  }
  
  return null;
}
