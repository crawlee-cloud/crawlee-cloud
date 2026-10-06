import { z } from 'zod';

/**
 * Boolean query param as sent by Apify clients. `apify-client` serializes
 * booleans with `Number(value)`, so they arrive as `1`/`0`; browsers and curl
 * users send `true`/`false`. Absent stays `undefined` so each route keeps its
 * own default (e.g. `desc` on /actor-runs defaults to true, `forefront` to
 * false). Anything else is a validation error rather than a silent `false`.
 */
export const zBoolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));
