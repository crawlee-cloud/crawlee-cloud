/**
 * Auth Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { authRoutes } from '../src/routes/auth.js';

const mockPoolQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

vi.mock('../src/auth/index.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed_password'),
  verifyPassword: vi.fn().mockResolvedValue(true),
  createToken: vi.fn().mockReturnValue('mock_jwt_token'),
  generateApiKey: vi.fn().mockReturnValue('apify_api_key_1234567890'),
  hashApiKey: vi.fn().mockResolvedValue('hashed_api_key'),
}));

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string } }) => {
    request.user = { id: 'user-1', email: 'test@example.com' };
  },
}));

describe('Auth Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await authRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  describe('POST /v2/auth/register', () => {
    it('should register new user', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // no existing user
        .mockResolvedValueOnce({ rows: [] }); // insert user

      const response = await app.inject({
        method: 'POST',
        url: '/v2/auth/register',
        payload: {
          email: 'new@example.com',
          password: 'password123',
          name: 'New User',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.user.email).toBe('new@example.com');
      expect(body.data.token).toBe('mock_jwt_token');
    });

    it('should reject existing email', async () => {
      mockPoolQuery.mockResolvedValueOnce({ 
        rows: [{ id: 'existing-user' }] 
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/auth/register',
        payload: {
          email: 'existing@example.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /v2/auth/login', () => {
    it('should login user', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          password_hash: 'hashed',
          name: 'Test User',
          role: 'user',
        }],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.token).toBe('mock_jwt_token');
    });

    it('should reject invalid credentials', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v2/auth/me', () => {
    it('should get current user', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: 'user',
          created_at: new Date(),
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/me',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /v2/auth/api-keys', () => {
    it('should create api key', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/auth/api-keys',
        payload: { name: 'My API Key' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.key).toBeDefined();
    });
  });

  describe('GET /v2/auth/api-keys', () => {
    it('should list api keys', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 'key-1', name: 'Key 1', key_preview: 'apify_api_...', is_active: true },
          { id: 'key-2', name: 'Key 2', key_preview: 'apify_api_...', is_active: true },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/auth/api-keys',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(2);
    });
  });

  describe('DELETE /v2/auth/api-keys/:keyId', () => {
    it('should revoke api key', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'key-1' }],
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/auth/api-keys/key-1',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 404 for non-existent key', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/v2/auth/api-keys/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
