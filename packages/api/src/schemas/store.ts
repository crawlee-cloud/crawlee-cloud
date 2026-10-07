import { z } from 'zod';
import { zBoolQuery } from './common.js';

export const STORE_DEFAULT_LIMIT = 10;
export const STORE_MAX_LIMIT = 100;
// Apify's cap when items carry their input schema (the MCP server's
// MAX_LIMIT_WITH_INPUT_SCHEMA): schemas can be large.
export const STORE_MAX_LIMIT_WITH_INPUT_SCHEMA = 10;

/**
 * Querystring for GET /v2/store (#119). `limit` is clamped rather than
 * rejected, like Apify's store: apify-client accepts any non-negative limit.
 * The Apify filters this instance has no data for (`category`,
 * `pricingModel`, `allowsAgenticUsers`, `sortBy`, `includeUnrunnableActors`)
 * are accepted and ignored — every actor is FREE, uncategorized and runnable.
 */
export const StoreListQuerySchema = z
  .object({
    search: z.string().optional(),
    limit: z.coerce.number().int().min(0).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    includeInputSchema: zBoolQuery.transform((v) => v ?? false),
    username: z.string().optional(),
    category: z.string().optional(),
    pricingModel: z.string().optional(),
    allowsAgenticUsers: z.string().optional(),
    sortBy: z.string().optional(),
    includeUnrunnableActors: z.string().optional(),
  })
  .transform(({ limit, ...q }) => {
    const max = q.includeInputSchema ? STORE_MAX_LIMIT_WITH_INPUT_SCHEMA : STORE_MAX_LIMIT;
    return {
      search: q.search?.trim() ?? '',
      limit: Math.min(max, Math.max(1, limit ?? STORE_DEFAULT_LIMIT)),
      offset: q.offset,
      includeInputSchema: q.includeInputSchema,
      username: q.username,
    };
  });

export type StoreListQuery = z.infer<typeof StoreListQuerySchema>;
