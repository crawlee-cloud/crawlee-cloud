/**
 * Three-tier proxy password resolver.
 *
 * Walked at run start (queue.ts) BEFORE buildActorEnv. The returned
 * `source` is logged for observability; the password value is only ever
 * passed into the env-injection function — never logged.
 */

import type pg from 'pg';
import { decryptProxyPassword } from './proxy-crypto.js';
import { config } from './config.js';

export type ProxySource = 'actor' | 'user' | 'platform' | 'none';

export interface ResolvedProxy {
  password: string | null;
  hostname: string | null;
  port: number | null;
  source: ProxySource;
}

export async function resolveProxy(
  pool: pg.Pool,
  actorId: string,
  userId: string | null
): Promise<ResolvedProxy> {
  const hostname = config.apifyProxyHostname || null;
  const port = config.apifyProxyPort || null;

  // Decrypt errors after a key rotation or DB corruption would otherwise
  // mark every run for that actor/user permanently FAILED. Skip the
  // affected tier instead so the resolver falls through to the next one
  // and the run can proceed (likely without proxy, but at least it runs).
  function safeDecrypt(enc: string, tier: ProxySource, ownerId: string): string | null {
    try {
      return decryptProxyPassword(enc);
    } catch (err) {
      console.warn(
        `[proxy-resolver] Failed to decrypt ${tier} proxy password for ${ownerId}; skipping tier:`,
        (err as Error).message
      );
      return null;
    }
  }

  // 1. Actor-level override.
  const actorRow = await pool.query<{ proxy_password_encrypted: string | null }>(
    'SELECT proxy_password_encrypted FROM actors WHERE id = $1',
    [actorId]
  );
  const actorEnc = actorRow.rows[0]?.proxy_password_encrypted ?? null;
  if (actorEnc) {
    const password = safeDecrypt(actorEnc, 'actor', actorId);
    if (password) {
      return { password, hostname, port, source: 'actor' };
    }
  }

  // 2. User-level setting.
  if (userId) {
    const userRow = await pool.query<{ proxy_password_encrypted: string | null }>(
      'SELECT proxy_password_encrypted FROM users WHERE id = $1',
      [userId]
    );
    const userEnc = userRow.rows[0]?.proxy_password_encrypted ?? null;
    if (userEnc) {
      const password = safeDecrypt(userEnc, 'user', userId);
      if (password) {
        return { password, hostname, port, source: 'user' };
      }
    }
  }

  // 3. Platform default from env.
  if (config.apifyProxyPassword) {
    return { password: config.apifyProxyPassword, hostname, port, source: 'platform' };
  }

  // 4. No password anywhere.
  return { password: null, hostname: null, port: null, source: 'none' };
}
