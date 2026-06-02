/**
 * AES-256-GCM helpers for the proxy password column.
 *
 * Storage format: `v1:<base64-iv>:<base64-ciphertext>:<base64-authtag>`
 * The `v1:` prefix lets future versions coexist without a migration.
 *
 * Key source: PROXY_ENCRYPTION_KEY (64 hex chars = 32 bytes) preferred.
 * Falls back to sha256(API_SECRET) in dev so single-secret deployments
 * still work; production startup must enforce the explicit key
 * (see config-validator.ts).
 *
 * DUPLICATED — keep in sync with packages/api/src/lib/proxy-crypto.ts.
 * See docs/superpowers/specs/2026-06-01-apify-proxy-design.md
 * for the rationale (no shared workspace exists; 30 lines doesn't
 * justify creating one).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const VERSION = 'v1';

function getKey(): Buffer {
  const envKey = process.env.PROXY_ENCRYPTION_KEY;
  if (envKey) {
    // Length-only validation isn't enough: Buffer.from(s, 'hex') truncates
    // at the first non-hex character. A 64-char string of mixed garbage
    // would pass .length === 64 and then yield a <32-byte buffer, breaking
    // the AES key invariant at runtime. Decode + check the resulting buffer.
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== 32) {
      throw new Error('PROXY_ENCRYPTION_KEY must be a valid 64-character hex string (32 bytes)');
    }
    return buf;
  }
  const fallback = process.env.API_SECRET;
  if (!fallback) {
    throw new Error(
      'Cannot derive proxy encryption key: neither PROXY_ENCRYPTION_KEY nor API_SECRET is set'
    );
  }
  return createHash('sha256').update(fallback).digest();
}

export function encryptProxyPassword(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    authTag.toString('base64'),
  ].join(':');
}

export function decryptProxyPassword(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Invalid proxy password format (expected ${VERSION}:iv:ct:tag)`);
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64!, 'base64');
  const ciphertext = Buffer.from(ctB64!, 'base64');
  const authTag = Buffer.from(tagB64!, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
