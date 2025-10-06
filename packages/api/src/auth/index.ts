/**
 * Authentication module for Crawlee Platform API.
 * 
 * Provides:
 * - API key generation and validation
 * - JWT token creation and verification
 * - Password hashing
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

const JWT_SECRET = config.apiSecret || 'crawlee-cloud-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';
const API_KEY_PREFIX = 'cp_';

export interface JWTPayload {
  userId: string;
  email?: string;
  role: 'admin' | 'user';
}

export interface APIKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Generate a new API key.
 */
export function generateApiKey(): string {
  const randomPart = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  return API_KEY_PREFIX + randomPart;
}

/**
 * Hash an API key for storage.
 */
export async function hashApiKey(key: string): Promise<string> {
  return bcrypt.hash(key, 10);
}

/**
 * Verify an API key against its hash.
 */
export async function verifyApiKey(key: string, hash: string): Promise<boolean> {
  return bcrypt.compare(key, hash);
}

/**
 * Hash a password.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify a password against its hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Create a JWT token.
 */
export function createToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify and decode a JWT token.
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Extract token from Authorization header.
 */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  
  // Support "Bearer <token>" format
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  
  // Support raw token
  return authHeader;
}
