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
import { appendSearchCondition } from '../db/search.js';
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

export const storeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/store — search the caller's actors.
   */
  fastify.get('/store', async (request) => {
    const q = StoreListQuerySchema.parse(request.query);

    const params: unknown[] = [request.user!.id];
    let where = appendSearchCondition('a.user_id = $1', params, q.search, [
      'a.name',
      'a.title',
      'a.description',
    ]);
    // Only the caller's actors are listed, so any other username is empty.
    if (q.username !== undefined) {
      params.push(q.username);
      where += ` AND u.username = $${params.length}`;
    }

    // Exact (case-insensitive) name match first, then most recently modified;
    // `id` keeps LIMIT/OFFSET paging stable on ties.
    const selectParams = [...params];
    let order = 'a.modified_at DESC, a.id DESC';
    if (q.search) {
      selectParams.push(q.search);
      order = `(LOWER(a.name) = LOWER($${selectParams.length})) DESC, ${order}`;
    }
    selectParams.push(q.limit, q.offset);

    // The runs subquery filters on user_id as well as actor_id so it walks
    // idx_runs_user_actor_created (there's no index on runs.actor_id alone).
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM actors a JOIN users u ON u.id = a.user_id
          WHERE ${where}`,
        params
      ),
      query<StoreActorRow>(
        `SELECT a.id, a.name, u.username, a.title, a.description,
                rs.total_runs, rs.last_run_started_at
           FROM actors a
           JOIN users u ON u.id = a.user_id
           CROSS JOIN LATERAL (
             SELECT COUNT(*)::int AS total_runs, MAX(r.created_at) AS last_run_started_at
               FROM runs r
              WHERE r.user_id = a.user_id AND r.actor_id = a.id
           ) rs
          WHERE ${where}
          ORDER BY ${order}
          LIMIT $${selectParams.length - 1} OFFSET $${selectParams.length}`,
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
