/**
 * Shared, user-scoped actor lookup for every route that takes `:actorId`.
 *
 * apify-client addresses actors as `username/name` and sends them as
 * `username~name` in the URL (it replaces the first `/` with `~`). The
 * Apify MCP server builds `actorFullName` the same way. Accepted forms:
 *
 *   - `id`
 *   - `name`
 *   - `username~name`
 *   - `username/name` (a `%2F` in the path arrives decoded in params)
 *
 * Lookups never cross users: the actor must belong to `userId`, and a
 * `username` part that isn't the caller's own resolves to nothing (404).
 * Actor names match `^[a-zA-Z0-9._-]+$` (schemas/actors.ts), so they never
 * contain `~` or `/` and splitting on the first one is unambiguous.
 */

import type pg from 'pg';
import { query } from '../db/index.js';

export interface ActorRow {
  id: string;
  name: string;
  user_id: string | null;
  title: string | null;
  description: string | null;
  default_run_options: Record<string, unknown> | null;
  max_retries: number;
  retry_delay_secs: number;
  proxy_password_encrypted: string | null;
  created_at: Date;
  modified_at: Date;
}

/**
 * An actor row joined with its owner's `users.username`. Null only when the
 * owner has no users row (actors.user_id has no FK — e.g. a JWT that
 * outlived its user); the id and name forms still resolve then.
 */
export interface ResolvedActor extends ActorRow {
  username: string | null;
}

/** Anything with pg's `query` — the pool helper or a transaction client. */
export interface Queryable {
  query<T extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

const defaultDb: Queryable = { query };

/**
 * Fastify `maxParamLength` for the API (src/index.ts and the integration
 * test app). The default of 100 is too short for `username~name` actor IDs
 * (username ≤ 30 + `~` + name ≤ 100); a longer param skips the route and
 * falls through to the not-found handler.
 */
export const MAX_PARAM_LENGTH = 256;

/**
 * Split `username~name` / `username/name` on the first separator. Returns
 * null when there is no separator or either side is empty.
 */
export function splitActorFullName(idOrName: string): { username: string; name: string } | null {
  const idx = idOrName.search(/[~/]/);
  if (idx <= 0 || idx === idOrName.length - 1) return null;
  return { username: idOrName.slice(0, idx), name: idOrName.slice(idx + 1) };
}

/**
 * Resolve `idOrName` to one of `userId`'s actors, or null. Pass a
 * transaction client as `db` to run the lookup inside a transaction.
 */
export async function resolveActor(
  idOrName: string,
  userId: string,
  db: Queryable = defaultDb
): Promise<ResolvedActor | null> {
  const full = splitActorFullName(idOrName);
  // Exact matches only (no LIKE): names may contain `-` and `.`.
  const result = await db.query<ResolvedActor>(
    `SELECT a.*, u.username
       FROM actors a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $2
        AND (a.id = $1 OR a.name = $1 OR (u.username = $3 AND a.name = $4))`,
    [idOrName, userId, full?.username ?? null, full?.name ?? null]
  );
  return result.rows[0] ?? null;
}

/** The 404 body every actor-scoped route returns for an unresolved actor. */
export const ACTOR_NOT_FOUND = {
  error: { type: 'record-not-found', message: 'Actor not found' },
} as const;
