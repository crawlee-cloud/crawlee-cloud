import { z } from 'zod';
import { zBoolQuery } from './common.js';

export const STORE_DEFAULT_LIMIT = 10;
export const STORE_MAX_LIMIT = 100;
// Apify's cap when items carry their input schema (the MCP server's
// MAX_LIMIT_WITH_INPUT_SCHEMA): schemas can be large.
export const STORE_MAX_LIMIT_WITH_INPUT_SCHEMA = 10;
export const STORE_MAX_OFFSET = 1_000_000;

/**
 * A string query param. Fastify parses a repeated param (`?a=x&a=y`) into an
 * array; take the first value instead of failing the whole search.
 */
const zFirstString = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.string().optional());

/**
 * Querystring for GET /v2/store (#119). `limit` is clamped rather than
 * rejected, like Apify's store: apify-client accepts any non-negative limit.
 * The Apify filters this instance has no data for (`category`,
 * `pricingModel`, `allowsAgenticUsers`, `sortBy`, `includeUnrunnableActors`)
 * are accepted and ignored — every actor is FREE, uncategorized and runnable.
 * An `offset` past STORE_MAX_OFFSET is clamped (the page is empty anyway),
 * and a repeated string param uses its first value.
 */
export const StoreListQuerySchema = z
  .object({
    search: zFirstString,
    limit: z.coerce.number().int().min(0).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    includeInputSchema: zBoolQuery.transform((v) => v ?? false),
    username: zFirstString,
    category: zFirstString,
    pricingModel: zFirstString,
    allowsAgenticUsers: zFirstString,
    sortBy: zFirstString,
    includeUnrunnableActors: zFirstString,
  })
  .transform(({ limit, ...q }) => {
    const max = q.includeInputSchema ? STORE_MAX_LIMIT_WITH_INPUT_SCHEMA : STORE_MAX_LIMIT;
    return {
      search: q.search?.trim() ?? '',
      limit: Math.min(max, Math.max(1, limit ?? STORE_DEFAULT_LIMIT)),
      offset: Math.min(q.offset, STORE_MAX_OFFSET),
      includeInputSchema: q.includeInputSchema,
      username: q.username,
    };
  });

export type StoreListQuery = z.infer<typeof StoreListQuerySchema>;
