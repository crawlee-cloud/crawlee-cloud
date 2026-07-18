/**
 * Setup functions for initial configuration.
 * Creates admin user and runner API key on first startup.
 */

import { nanoid } from 'nanoid';
import { pool } from './db/index.js';
import {
  hashPassword,
  generateApiKey,
  hashApiKey,
  sha256ApiKey,
  verifyApiKey,
} from './auth/index.js';
import { config } from './config.js';
import { redis } from './storage/redis.js';

const RUNNER_API_KEY_NAME = '__runner_service_key';
const RUNNER_API_KEY_REDIS_KEY = 'runner:api-key';

/**
 * Create admin user from environment variables if:
 * 1. ADMIN_EMAIL and ADMIN_PASSWORD are set
 * 2. No user with that email exists yet
 */
export async function setupAdminUser(): Promise<void> {
  const { adminEmail, adminPassword } = config;

  if (!adminEmail || !adminPassword) {
    console.log('[Setup] No ADMIN_EMAIL/ADMIN_PASSWORD set - skipping admin creation');
    return;
  }

  if (adminPassword.length < 8) {
    console.error('[Setup] ADMIN_PASSWORD must be at least 8 characters');
    return;
  }

  try {
    // Check if admin already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);

    let adminUserId: string;

    if (existing.rows.length > 0) {
      adminUserId = existing.rows[0].id as string;
      console.log(`[Setup] Admin user ${adminEmail} already exists`);
    } else {
      // Create admin user
      adminUserId = nanoid();
      const passwordHash = await hashPassword(adminPassword);

      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, role, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [adminUserId, adminEmail, passwordHash, 'Admin', 'admin']
      );

      console.log(`[Setup] ✓ Admin user created: ${adminEmail}`);
    }

    // Create runner API key (needs admin user ID)
    await setupRunnerApiKey(adminUserId);
  } catch (error) {
    console.error('[Setup] Failed to create admin user:', error);
  }
}

/**
 * Create a dedicated API key for the runner service.
 * The raw key is stored in Redis so the runner can fetch it on startup.
 * Exported for tests — production callers go through setupAdminUser().
 */
export async function setupRunnerApiKey(adminUserId: string): Promise<void> {
  try {
    // Check if runner key already exists
    const existing = await pool.query<{
      id: string;
      user_id: string;
      key_hash: string;
      key_sha256: string | null;
    }>(
      'SELECT id, user_id, key_hash, key_sha256 FROM api_keys WHERE name = $1 AND is_active = true',
      [RUNNER_API_KEY_NAME]
    );

    // Check if the raw key is still in Redis
    const existingKey = await redis.get(RUNNER_API_KEY_REDIS_KEY);

    // Reuse only when the key exists in BOTH stores AND is bound to the
    // current admin AND the Redis raw key actually verifies against the
    // DB row. The last check is load-bearing: Redis and Postgres can
    // diverge (2026-07-17 prod outage — Redis held a raw key whose hash
    // was not in the DB, so every actor container 401'd until manual
    // intervention; presence-only reuse kept "healing" the wrong state
    // on every boot). Prefer the cheap sha256 comparison when the column
    // is populated; fall back to one bcrypt compare for legacy rows.
    // If the admin user changed since last setup, the key would still
    // authenticate, but every storage route scopes by user_id — so actor
    // runs would 404 on their own datasets/KV/queues.
    const existingRow = existing.rows[0];
    if (existingRow && existingKey && existingRow.user_id === adminUserId) {
      const rawMatchesRow = existingRow.key_sha256
        ? sha256ApiKey(existingKey) === existingRow.key_sha256
        : await verifyApiKey(existingKey, existingRow.key_hash);
      if (rawMatchesRow) {
        console.log('[Setup] Runner API key already exists');
        return;
      }
      console.warn(
        '[Setup] Runner API key mismatch: Redis raw key does not verify against the DB row — regenerating'
      );
    }

    // Deactivate any old runner keys (any user, including stale bindings)
    if (existing.rows.length > 0) {
      await pool.query('UPDATE api_keys SET is_active = false WHERE name = $1', [
        RUNNER_API_KEY_NAME,
      ]);
      if (existingRow && existingRow.user_id !== adminUserId) {
        console.log(
          `[Setup] Runner API key was bound to stale user ${existingRow.user_id}, regenerating for admin ${adminUserId}`
        );
      }
    }

    // Generate new runner API key
    const keyId = nanoid();
    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);

    await pool.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_sha256, key_preview, created_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), true)`,
      [
        keyId,
        adminUserId,
        RUNNER_API_KEY_NAME,
        keyHash,
        sha256ApiKey(rawKey),
        rawKey.slice(0, 12) + '...',
      ]
    );

    // Store raw key in Redis (no expiry - persists until regenerated)
    await redis.set(RUNNER_API_KEY_REDIS_KEY, rawKey);

    console.log('[Setup] ✓ Runner API key created and stored in Redis');
  } catch (error) {
    console.error('[Setup] Failed to create runner API key:', error);
  }
}
