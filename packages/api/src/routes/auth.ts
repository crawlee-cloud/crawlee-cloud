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

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { pool } from '../db/index.js';
import { 
  hashPassword, 
  verifyPassword, 
  createToken, 
  generateApiKey, 
  hashApiKey 
} from '../auth/index.js';
import { authenticate } from '../auth/middleware.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const apiKeySchema = z.object({
  name: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  /**
   * Register a new user.
   */
  app.post('/v2/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    
    // Check if email exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [body.email]
    );
    
    if (existing.rows.length > 0) {
      return reply.status(400).send({ error: { message: 'Email already registered' } });
    }
    
    const userId = nanoid();
    const passwordHash = await hashPassword(body.password);
    
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, created_at) 
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, body.email, passwordHash, body.name || null]
    );
    
    const token = createToken({ userId, email: body.email, role: 'user' });
    
    return reply.status(201).send({
      data: {
        user: { id: userId, email: body.email, name: body.name },
        token,
      },
    });
  });
  
  /**
   * Login and get JWT token.
   */
  app.post('/v2/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    
    const result = await pool.query<{ id: string; email: string; password_hash: string; name: string | null; role: string }>(
      'SELECT id, email, password_hash, name, role FROM users WHERE email = $1',
      [body.email]
    );
    
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
      role: user.role as 'admin' | 'user' 
    });
    
    return reply.send({
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token,
      },
    });
  });
  
  /**
   * Get current user info.
   */
  app.get('/v2/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });
    
    const result = await pool.query<{ id: string; email: string; name: string | null; role: string; created_at: Date }>(
      'SELECT id, email, name, role, created_at FROM users WHERE id = $1',
      [user.id]
    );
    
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: { message: 'User not found' } });
    }
    
    return reply.send({ data: result.rows[0] });
  });
  
  /**
   * Create a new API key.
   */
  app.post('/v2/auth/api-keys', { preHandler: authenticate }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });
    
    const body = apiKeySchema.parse(request.body);
    
    const keyId = nanoid();
    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);
    
    await pool.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_preview, created_at, is_active) 
       VALUES ($1, $2, $3, $4, $5, NOW(), true)`,
      [keyId, user.id, body.name, keyHash, rawKey.slice(0, 12) + '...']
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
  app.get('/v2/auth/api-keys', { preHandler: authenticate }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: { message: 'Not authenticated' } });
    
    const result = await pool.query(
      `SELECT id, name, key_preview, created_at, last_used_at, is_active 
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id]
    );
    
    return reply.send({ data: result.rows });
  });
  
  /**
   * Revoke an API key.
   */
  app.delete('/v2/auth/api-keys/:keyId', { preHandler: authenticate }, async (request, reply) => {
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
    
    return reply.send({ data: { message: 'API key revoked' } });
  });
}
