import { z } from 'zod';

export const UpdateRunSchema = z.object({
  status: z.enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']).optional(),
  statusMessage: z.string().max(1000).optional(),
});

/**
 * Querystring shape for GET /v2/actor-runs. All fields are optional; defaults
 * are applied in the route. limit caps at 200 to bound DB scan + JSON payload
 * size — operators triaging at scale want quick pages, not 1000-row dumps.
 */
export const ListRunsQuerySchema = z.object({
  // ABORTING is included on the read path even though no current code path
  // sets it — the dashboard groups it with ABORTED for filtering. Keeping it
  // accepted here lets the UI stay forward-compatible without a server roundtrip.
  status: z
    .enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTING', 'ABORTED'])
    .optional(),
  actorId: z.string().min(1).max(21).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  desc: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? true : v === true || v === 'true')),
});

export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
