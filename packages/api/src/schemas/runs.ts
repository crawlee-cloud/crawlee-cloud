import { z } from 'zod';
import { zBoolQuery } from './common.js';

export const UpdateRunSchema = z.object({
  status: z.enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']).optional(),
  statusMessage: z.string().max(1000).optional(),
});

const RUN_STATUSES = [
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMING-OUT',
  'TIMED-OUT',
  'ABORTING',
  'ABORTED',
] as const;

/**
 * Querystring shape for GET /v2/actor-runs and GET /v2/acts/:actorId/runs.
 * All fields are optional; defaults are applied in the route. limit caps at
 * 200 to bound DB scan + JSON payload size — operators triaging at scale want
 * quick pages, not 1000-row dumps.
 *
 * Non-strict on purpose: unknown Apify params are stripped, not rejected.
 */
export const ListRunsQuerySchema = z
  .object({
    // ABORTING and TIMING-OUT are included on the read path even though no
    // current code path sets them — the dashboard groups ABORTING with ABORTED,
    // and Apify clients (e.g. the MCP get-actor-run-list tool) may filter by
    // TIMING-OUT. apify-client sends a status array comma-joined
    // (`SUCCEEDED,FAILED`), so a comma-separated list is accepted too; a
    // repeated `?status=` param arrives as an array and is flattened.
    status: z
      .union([z.string(), z.array(z.string())])
      .transform((v) =>
        (Array.isArray(v) ? v : [v])
          .flatMap((s) => s.split(','))
          .map((s) => s.trim())
          .filter((s) => s !== '')
      )
      .pipe(z.array(z.enum(RUN_STATUSES)).min(1))
      .optional(),
    actorId: z.string().min(1).max(21).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    // apify-client's names for since/until. Explicit since/until win.
    startedAfter: z.string().datetime().optional(),
    startedBefore: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    // apify-client sends 1/0; absent defaults to newest-first.
    desc: zBoolQuery.transform((v) => v ?? true),
  })
  .transform(({ startedAfter, startedBefore, ...q }) => ({
    ...q,
    since: q.since ?? startedAfter,
    until: q.until ?? startedBefore,
  }));

export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

/**
 * Querystring for GET /v2/actor-runs/histogram. `hours` controls the trailing
 * window AND the bucket count (one bucket per hour). Capped at 168 = 7d so the
 * generate_series spine never produces more than a week of rows.
 */
export const RunsHistogramQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).optional(),
});

export type RunsHistogramQuery = z.infer<typeof RunsHistogramQuerySchema>;
