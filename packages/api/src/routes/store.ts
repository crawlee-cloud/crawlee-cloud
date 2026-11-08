/**
 * Store routes — Apify-compatible GET /v2/store (#119).
 *
 * apify-client's `store().list()` calls it, and the Apify MCP server's
 * `search-actors` tool depends on it (`fetch-actor-details` also calls it,
 * but only for `pictureUrl`, and ignores failures). A self-hosted instance
 * has no public store: the "store" is the caller's own actors. Cross-user
 * discovery is out of scope by decision.
 */

import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/index.js';
import { escapeLikePattern } from '../db/like.js';
import { authenticate } from '../auth/middleware.js';
import { selectDefaultInputSchemas } from '../lib/builds.js';
import { StoreListQuerySchema } from '../schemas/store.js';

export interface StoreActorRow {
  id: string;
  name: string;
  username: string;
  title: string | null;
  description: string | null;
  total_runs: number;
  last_run_started_at: Date | null;
}

/**
 * The input schema as an item's `inputSchema`, or null. The MCP server
 * reads `Object.entries(inputSchema.properties)` on any non-null value, so a
 * schema without a `properties` object is reported as no schema rather than
 * crashing the search.
 */
export function storeInputSchema(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { properties } = input as { properties?: unknown };
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return input as Record<string, unknown>;
}

/**
 * An Apify store item (apify-client's ActorStoreList). Fields with no
 * equivalent here get neutral values the MCP actor card handles: no picture,
 * no categories, FREE pricing, and `stats` without user counts or ratings
 * (the card then skips those lines). `url` is null: there is no store page.
 * `inputSchema` is present only when requested.
 */
export function formatStoreItem(row: StoreActorRow, inputSchema?: Record<string, unknown> | null) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    // The MCP card renders the title as the heading; Apify titles are never empty.
    title: row.title || row.name,
    description: row.description,
    pictureUrl: null,
    userPictureUrl: null,
    categories: [],
    stats: {
      totalRuns: Number(row.total_runs),
      lastRunStartedAt: row.last_run_started_at ?? null,
    },
    currentPricingInfo: { pricingModel: 'FREE' },
    url: null,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

const SEARCH_COLUMNS = [
  'a.name',
  'a.title',
  'a.description',
  'u.username',
  "(u.username || '/' || a.name)",
];

export const storeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/store — search the caller's actors.
   */
  fastify.get('/store', async (request) => {
    const q = StoreListQuerySchema.parse(request.query);

    const params: unknown[] = [request.user!.id];
    let where = 'a.user_id = $1';
    // Apify's store search is keyword search: the MCP `search-actors` tool
    // sends space-separated keywords ("echo input actor"). Every term must
    // match at least one field. Apify also matches the owner's username; the
    // combined `username/name` handle is our extension (agents search with
    // the handle they saw elsewhere).
    for (const term of q.search.split(/\s+/).filter(Boolean)) {
      params.push(`%${escapeLikePattern(term)}%`);
      const p = `$${params.length}`;
      where += ` AND (${SEARCH_COLUMNS.map((c) => `${c} ILIKE ${p}`).join(' OR ')})`;
    }
    // Only the caller's actors are listed, so any other username is empty.
    // Usernames are case-insensitive, like Apify's.
    if (q.username !== undefined) {
      params.push(q.username);
      where += ` AND LOWER(u.username) = LOWER($${params.length})`;
    }

    // Exact (case-insensitive) name or `username/name` match first, then most
    // recently modified; `id` keeps LIMIT/OFFSET paging stable on ties. The
    // same order runs inside the page subquery (where the username is
    // `u.username`) and outside it (where the page row carries it).
    const selectParams = [...params];
    let searchIdx: number | undefined;
    if (q.search) {
      selectParams.push(q.search);
      searchIdx = selectParams.length;
    }
    const orderBy = (username: string) => {
      const recency = 'a.modified_at DESC, a.id DESC';
      if (searchIdx === undefined) return recency;
      const term = `LOWER($${searchIdx})`;
      return `(LOWER(a.name) = ${term} OR LOWER(${username} || '/' || a.name) = ${term}) DESC, ${recency}`;
    };
    selectParams.push(q.limit, q.offset);

    // Page the actors first, then aggregate runs for that page only: the
    // aggregate below the LIMIT would scan every run of every matching actor.
    // The runs subquery filters on user_id as well as actor_id so it walks
    // idx_runs_user_actor_created (there's no index on runs.actor_id alone).
    // `lastRunStartedAt` is the newest actual start: runs that never started
    // (READY, aborted before start) count in totalRuns but have no start
    // time, so an actor with only such runs reports null.
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM actors a JOIN users u ON u.id = a.user_id
          WHERE ${where}`,
        params
      ),
      query<StoreActorRow>(
        `SELECT a.id, a.name, a.username, a.title, a.description,
                rs.total_runs, rs.last_run_started_at
           FROM (
             SELECT a.id, a.user_id, a.name, u.username, a.title, a.description, a.modified_at
               FROM actors a
               JOIN users u ON u.id = a.user_id
              WHERE ${where}
              ORDER BY ${orderBy('u.username')}
              LIMIT $${selectParams.length - 1} OFFSET $${selectParams.length}
           ) a
           CROSS JOIN LATERAL (
             SELECT COUNT(*)::int AS total_runs, MAX(r.started_at) AS last_run_started_at
               FROM runs r
              WHERE r.user_id = a.user_id AND r.actor_id = a.id
           ) rs
          ORDER BY ${orderBy('a.username')}`,
        selectParams
      ),
    ]);

    const rows = pageResult.rows;
    const schemas = q.includeInputSchema
      ? await selectDefaultInputSchemas(rows.map((row) => row.id))
      : undefined;

    return {
      data: {
        total: parseInt(countResult.rows[0]?.total ?? '0', 10),
        count: rows.length,
        offset: q.offset,
        limit: q.limit,
        desc: false,
        items: rows.map((row) =>
          formatStoreItem(row, schemas ? storeInputSchema(schemas.get(row.id)) : undefined)
        ),
      },
    };
  });
};
