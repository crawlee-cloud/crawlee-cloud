/**
 * Run routes - Apify-compatible endpoints for Actor runs.
 */

import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';
import { UpdateRunSchema, ListRunsQuerySchema, RunsHistogramQuerySchema } from '../schemas/runs.js';

interface RunRow {
  id: string;
  actor_id: string | null;
  user_id: string | null;
  status: string;
  status_message: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  default_dataset_id: string | null;
  default_key_value_store_id: string | null;
  default_request_queue_id: string | null;
  timeout_secs: number;
  memory_mbytes: number;
  container_url: string | null;
  build_id: string | null;
  build_number: string | null;
  exit_code: number | null;
  stats_json: Record<string, unknown> | null;
  retry_count: number;
  origin_run_id: string | null;
  run_after: Date | null;
  created_at: Date;
  modified_at: Date;
  /**
   * Joined from `datasets.item_count` via LEFT JOIN on `default_dataset_id`.
   * Null when the run has no default dataset; otherwise the live count
   * maintained atomically by the dataset push endpoint (see
   * routes/datasets.ts, the CTE that does `UPDATE datasets SET item_count
   * = item_count + N ... RETURNING item_count`).
   *
   * Lives on every endpoint that returns a formatRun so the dashboard
   * can render an Items column without an N+1 round-trip per row.
   */
  default_dataset_item_count: number | null;
}

/**
 * Shared SELECT for any query feeding `formatRun`. The LEFT JOIN is on
 * the datasets PK (cheap, no row multiplication — datasets are 1:1 with
 * `runs.default_dataset_id`). Centralized so all call sites stay in
 * lockstep: a divergence here would have some endpoints emit live
 * `defaultDatasetItemCount` and others emit `null` for the same run.
 */
const RUN_SELECT_WITH_DATASET_COUNT = `
  SELECT r.*, d.item_count AS default_dataset_item_count
  FROM runs r
  LEFT JOIN datasets d ON d.id = r.default_dataset_id
`;

export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/actor-runs - List runs (user-scoped, filterable, paginated).
   *
   * Query params (all optional):
   *   status   = READY|RUNNING|SUCCEEDED|FAILED|TIMED-OUT|ABORTED
   *   actorId  = filter to one actor
   *   since    = ISO datetime, runs created at >= this
   *   until    = ISO datetime, runs created at <  this
   *   limit    = page size, default 50, max 200
   *   offset   = page offset, default 0
   *   desc     = sort by created_at desc (default true). 'false' for asc.
   *
   * Returns Apify-shaped { data: { total, count, offset, limit, desc, items } }
   * where total is the *real* count of matching rows (not the page size).
   */
  fastify.get('/actor-runs', async (request) => {
    const q = ListRunsQuerySchema.parse(request.query);
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const desc = q.desc;

    // Build WHERE clause dynamically while keeping queries parameterised.
    // Columns are qualified with `r.` because the SELECT below LEFT JOINs
    // datasets, and `user_id` / `created_at` exist on BOTH tables —
    // unqualified references would error with "column reference is
    // ambiguous". The COUNT query doesn't join, but using `r.` there
    // too keeps the where-builder uniform (and harmless: bare-`runs`
    // can be aliased to `r` via the table-alias form below).
    const where: string[] = ['r.user_id = $1'];
    const params: unknown[] = [request.user!.id];
    let p = 2;
    if (q.status !== undefined) {
      where.push(`r.status = $${p++}`);
      params.push(q.status);
    }
    if (q.actorId !== undefined) {
      where.push(`r.actor_id = $${p++}`);
      params.push(q.actorId);
    }
    if (q.since !== undefined) {
      where.push(`r.created_at >= $${p++}`);
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push(`r.created_at < $${p++}`);
      params.push(q.until);
    }
    const whereSql = where.join(' AND ');

    // COUNT and SELECT run in parallel — both share the same composite index
    // so the count query is cheap up to ~hundreds of thousands of rows.
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM runs r WHERE ${whereSql}`,
        params
      ),
      query<RunRow>(
        // Stable tiebreaker on `id`. Without it, LIMIT/OFFSET pagination
        // can drop or duplicate rows when two runs share the exact same
        // created_at (ms-precision ties are realistic at 140 scrapers ×
        // burst writes — Postgres doesn't guarantee row order on ties).
        //
        // WHERE-clause columns are `r.`-qualified above because the
        // LEFT JOIN below brings in `datasets`, which shares the
        // `user_id` and `created_at` column names with `runs` —
        // unqualified references would error with "column reference
        // is ambiguous". `status` and `actor_id` are not ambiguous
        // today, but qualifying them keeps the where-builder uniform
        // and protects against future columns being added on either
        // side of the join.
        `${RUN_SELECT_WITH_DATASET_COUNT}
         WHERE ${whereSql}
         ORDER BY r.created_at ${desc ? 'DESC' : 'ASC'}, r.id ${desc ? 'DESC' : 'ASC'}
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    return {
      data: {
        total,
        count: pageResult.rows.length,
        offset,
        limit,
        desc,
        items: pageResult.rows.map(formatRun),
      },
    };
  });

  /**
   * GET /v2/actor-runs/stats - Aggregate counts for the operator dashboard.
   *
   * Single indexed query returns all status counters and the 24h failure
   * count. Replaces the old client-side aggregation that filtered the first
   * page of /v2/actor-runs (capped at 50 rows) and silently under-counted
   * once a user crossed 50 runs total.
   *
   * Static path is registered before `/actor-runs/:runId` so Fastify's trie
   * matches "stats" literally rather than as a runId.
   */
  fastify.get('/actor-runs/stats', async (request) => {
    // `failed` counts FAILED and TIMED-OUT together — TIMED-OUT is
    // operationally a failure (platform killed the run for missing its
    // deadline) and the dashboard's hourly histogram already groups them
    // the same way. ABORTED stays excluded: that's operator cancellation,
    // not a failure.
    const result = await query<{
      total: string;
      running: string;
      succeeded: string;
      failed: string;
      failed_last_24h: string;
    }>(
      // `failed_last_24h` uses the same hour-aligned 24h window as
      // /actor-runs/histogram (`date_trunc('hour', NOW()) - 23 hours`)
      // so the "Failed · 24h" tile and the histogram's red caps cover
      // the same span. A rolling `NOW() - 24 hours` window would drift
      // up to 59 minutes from the histogram's hour-bucketed start at
      // the top of each hour, making the two views silently disagree.
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'RUNNING')::text AS running,
         COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::text AS succeeded,
         COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMED-OUT'))::text AS failed,
         COUNT(*) FILTER (
           WHERE status IN ('FAILED', 'TIMED-OUT')
             AND created_at >= date_trunc('hour', NOW()) - INTERVAL '23 hours'
         )::text AS failed_last_24h
       FROM runs
       WHERE user_id = $1`,
      [request.user!.id]
    );
    const row = result.rows[0]!;
    return {
      data: {
        total: parseInt(row.total, 10),
        running: parseInt(row.running, 10),
        succeeded: parseInt(row.succeeded, 10),
        failed: parseInt(row.failed, 10),
        failedLast24h: parseInt(row.failed_last_24h, 10),
      },
    };
  });

  /**
   * GET /v2/actor-runs/histogram - Hourly run counts for the dashboard.
   *
   * Returns exactly `hours` rows, one per wall-clock hour ending at the current
   * hour. Empty hours come back as zero-count buckets (via generate_series spine
   * + LEFT JOIN), so the client can render a fixed-width chart without holes.
   *
   * Aggregation is server-side: we never ship row-level run data for this view,
   * which keeps the payload bounded (≤168 rows) regardless of cluster volume.
   *
   * Static path is registered before `/actor-runs/:runId` so Fastify's trie
   * matches "histogram" literally rather than as a runId.
   *
   * Failure semantics match the `/stats` endpoint: FAILED ∪ TIMED-OUT.
   */
  fastify.get('/actor-runs/histogram', async (request) => {
    const q = RunsHistogramQuerySchema.parse(request.query);
    const hours = q.hours ?? 24;

    // make_interval keeps `hours` parameterised — no SQL string-building. The
    // spine is `hours` rows: [now-hour - (hours-1)h, ..., now-hour].
    const result = await query<{ bucket: Date; total: string; failed: string }>(
      `WITH spine AS (
         SELECT generate_series(
           date_trunc('hour', NOW()) - make_interval(hours => $2 - 1),
           date_trunc('hour', NOW()),
           INTERVAL '1 hour'
         ) AS bucket
       ),
       agg AS (
         SELECT
           date_trunc('hour', created_at) AS bucket,
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMED-OUT'))::text AS failed
         FROM runs
         WHERE user_id = $1
           AND created_at >= date_trunc('hour', NOW()) - make_interval(hours => $2 - 1)
         GROUP BY bucket
       )
       SELECT
         spine.bucket,
         COALESCE(agg.total, '0') AS total,
         COALESCE(agg.failed, '0') AS failed
       FROM spine
       LEFT JOIN agg USING (bucket)
       ORDER BY spine.bucket ASC`,
      [request.user!.id, hours]
    );

    return {
      data: {
        hours,
        buckets: result.rows.map((r) => ({
          hour: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
          total: parseInt(r.total, 10),
          failed: parseInt(r.failed, 10),
        })),
      },
    };
  });

  /**
   * GET /v2/actor-runs/:runId - Get run (user-scoped)
   */
  fastify.get<{ Params: { runId: string } }>('/actor-runs/:runId', async (request, reply) => {
    const { runId } = request.params;

    const result = await query<RunRow>(`${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`, [
      runId,
      request.user!.id,
    ]);

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    return { data: formatRun(result.rows[0]) };
  });

  /**
   * PUT /v2/actor-runs/:runId - Update run status
   */
  fastify.put<{
    Params: { runId: string };
    Body: {
      status?: string;
      statusMessage?: string;
    };
  }>('/actor-runs/:runId', async (request, reply) => {
    const { runId } = request.params;
    const { status, statusMessage } = UpdateRunSchema.parse(request.body);

    const setClauses: string[] = ['modified_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(status);

      // Set finished_at if terminal status
      if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
        setClauses.push('finished_at = NOW()');
      }
    }
    if (statusMessage !== undefined) {
      setClauses.push(`status_message = $${paramIndex++}`);
      values.push(statusMessage);
    }

    values.push(runId);

    // Add user_id filter for authorization
    values.push(request.user!.id);
    // CTE pattern: UPDATE returns the touched row, then we LEFT JOIN it
    // against datasets to populate default_dataset_item_count for the
    // formatRun output. Without this, the mutating endpoints would return
    // a payload that lacks `defaultDatasetItemCount` while LIST and GET
    // include it — the divergence the centralized `formatRun` contract
    // is meant to prevent.
    const result = await query<RunRow>(
      `
      WITH updated AS (
        UPDATE runs SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
        RETURNING *
      )
      SELECT r.*, d.item_count AS default_dataset_item_count
      FROM updated r
      LEFT JOIN datasets d ON d.id = r.default_dataset_id
    `,
      values
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    return { data: formatRun(result.rows[0]) };
  });

  /**
   * POST /v2/actor-runs/:runId/abort - Abort run (user-scoped)
   */
  fastify.post<{ Params: { runId: string } }>(
    '/actor-runs/:runId/abort',
    async (request, reply) => {
      const { runId } = request.params;

      // CTE pattern (see PUT handler above for rationale) — keeps the
      // formatRun output shape consistent across endpoints.
      const result = await query<RunRow>(
        `
      WITH updated AS (
        UPDATE runs
        SET status = 'ABORTED', finished_at = NOW(), modified_at = NOW()
        WHERE id = $1 AND status = 'RUNNING' AND user_id = $2
        RETURNING *
      )
      SELECT r.*, d.item_count AS default_dataset_item_count
      FROM updated r
      LEFT JOIN datasets d ON d.id = r.default_dataset_id
    `,
        [runId, request.user!.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return {
          error: { type: 'record-not-found', message: 'Run not found or already finished' },
        };
      }

      return { data: formatRun(result.rows[0]) };
    }
  );

  /**
   * POST /v2/actor-runs/:runId/resurrect - Resurrect failed run (user-scoped)
   */
  fastify.post<{ Params: { runId: string } }>(
    '/actor-runs/:runId/resurrect',
    async (request, reply) => {
      const { runId } = request.params;

      // CTE pattern (see PUT handler above for rationale) — keeps the
      // formatRun output shape consistent across endpoints.
      const result = await query<RunRow>(
        `
      WITH updated AS (
        UPDATE runs
        SET status = 'RUNNING', finished_at = NULL, modified_at = NOW()
        WHERE id = $1 AND status IN ('FAILED', 'ABORTED', 'TIMED-OUT') AND user_id = $2
        RETURNING *
      )
      SELECT r.*, d.item_count AS default_dataset_item_count
      FROM updated r
      LEFT JOIN datasets d ON d.id = r.default_dataset_id
    `,
        [runId, request.user!.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return {
          error: { type: 'record-not-found', message: 'Run not found or not in terminal state' },
        };
      }

      return { data: formatRun(result.rows[0]) };
    }
  );

  /**
   * POST /v2/actor-runs/:runId/ingest-crawler-stats
   *
   * Read SDK_CRAWLER_STATISTICS_0 from the run's default KV store and stamp
   * it onto runs.stats_json so the runs API and webhook payload's
   * resource.stats carry real numbers (requestsFinished, requestsFailed,
   * errors, crawlerRuntimeMillis, ...) instead of zero placeholders.
   *
   * Called by the runner immediately after a run reaches a terminal state.
   * Also callable ad-hoc by operators on past runs whose stats file showed
   * up after the fact (e.g. uploaded manually). No-op (200 with stats=null
   * in body) when the stats record doesn't exist — that's the normal
   * outcome for actors that crashed before crawler.run().
   */
  fastify.post<{ Params: { runId: string } }>(
    '/actor-runs/:runId/ingest-crawler-stats',
    async (request, reply) => {
      const { runId } = request.params;

      const runResult = await query<{
        id: string;
        default_key_value_store_id: string;
        user_id: string;
      }>(
        `SELECT id, default_key_value_store_id, user_id FROM runs WHERE id = $1 AND user_id = $2`,
        [runId, request.user!.id]
      );
      if (!runResult.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Run not found' } };
      }

      const { getKVRecord } = await import('../storage/s3.js');
      const record = await getKVRecord(
        runResult.rows[0].default_key_value_store_id,
        'SDK_CRAWLER_STATISTICS_0'
      );

      if (!record) {
        // Normal for runs that crashed before the crawler ran. Don't 404 —
        // the caller (runner) doesn't need to distinguish "no stats" from
        // "run missing"; both are quiet outcomes.
        return { data: { stats: null, message: 'No SDK_CRAWLER_STATISTICS_0 in KV store' } };
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(record.value.toString('utf8')) as Record<string, unknown>;
      } catch (err) {
        reply.status(422);
        return {
          error: {
            type: 'invalid-stats',
            message: `Could not parse stats JSON: ${(err as Error).message}`,
          },
        };
      }

      // Normalize Crawlee's keys onto the Apify-compatible shape we already
      // expose on runs.stats_json. Extra fields are preserved verbatim under
      // `crawler` so receivers that want the full Crawlee picture have it.
      const stats = {
        inputBodyLen: typeof raw.inputBodyLen === 'number' ? raw.inputBodyLen : 0,
        restartCount: typeof raw.restartCount === 'number' ? raw.restartCount : 0,
        resurrectCount: typeof raw.resurrectCount === 'number' ? raw.resurrectCount : 0,
        runTimeSecs:
          typeof raw.crawlerRuntimeMillis === 'number'
            ? Math.round(raw.crawlerRuntimeMillis / 1000)
            : 0,
        computeUnits: 0,
        // Crawlee-specific extension — receivers branching on these get richer info.
        requestsFinished: typeof raw.requestsFinished === 'number' ? raw.requestsFinished : 0,
        requestsFailed: typeof raw.requestsFailed === 'number' ? raw.requestsFailed : 0,
        requestsTotal: typeof raw.requestsTotal === 'number' ? raw.requestsTotal : 0,
        requestsRetries: typeof raw.requestsRetries === 'number' ? raw.requestsRetries : 0,
        crawlerRuntimeMillis:
          typeof raw.crawlerRuntimeMillis === 'number' ? raw.crawlerRuntimeMillis : 0,
        crawlerStartedAt: typeof raw.crawlerStartedAt === 'string' ? raw.crawlerStartedAt : null,
        crawlerFinishedAt: typeof raw.crawlerFinishedAt === 'string' ? raw.crawlerFinishedAt : null,
      };

      await query('UPDATE runs SET stats_json = $1, modified_at = NOW() WHERE id = $2', [
        stats,
        runId,
      ]);

      return { data: { stats } };
    }
  );

  /**
   * GET /v2/actor-runs/:runId/dataset/items - Get run's dataset items
   * (Convenience endpoint)
   */
  fastify.get<{
    Params: { runId: string };
    Querystring: { offset?: string; limit?: string };
  }>('/actor-runs/:runId/dataset/items', async (request, reply) => {
    const { runId } = request.params;
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const run = await query<RunRow>(`${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`, [
      runId,
      request.user!.id,
    ]);

    if (!run.rows[0] || !run.rows[0].default_dataset_id) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run or dataset not found' } };
    }

    // Redirect to dataset items endpoint
    const { listDatasetItems } = await import('../storage/s3.js');
    const { items, total } = await listDatasetItems(run.rows[0].default_dataset_id, {
      offset,
      limit,
    });

    reply.header('x-apify-pagination-total', total);
    reply.header('x-apify-pagination-offset', offset);
    reply.header('x-apify-pagination-limit', limit);

    return items;
  });

  /**
   * GET /v2/actor-runs/:runId/key-value-store/records/:key - Get run's KV record
   * (Convenience endpoint)
   */
  fastify.get<{ Params: { runId: string; key: string } }>(
    '/actor-runs/:runId/key-value-store/records/:key',
    async (request, reply) => {
      const { runId, key } = request.params;

      const run = await query<RunRow>(`${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`, [
        runId,
        request.user!.id,
      ]);

      if (!run.rows[0] || !run.rows[0].default_key_value_store_id) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Run or KV store not found' } };
      }

      const { getKVRecord } = await import('../storage/s3.js');
      const record = await getKVRecord(run.rows[0].default_key_value_store_id, key);

      if (!record) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Record not found' } };
      }

      reply.header('content-type', record.contentType);
      return reply.send(record.value);
    }
  );
};

function formatRun(row: RunRow) {
  return {
    id: row.id,
    actId: row.actor_id,
    userId: row.user_id,
    status: row.status,
    statusMessage: row.status_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    defaultDatasetId: row.default_dataset_id,
    /**
     * Live item count from the joined `datasets` row. Two normal cases:
     *   - `default_dataset_id` is NULL (no dataset, e.g. run failed
     *     before SDK init) → this field is also null, dashboard renders "—".
     *   - dataset exists → this field is the live count (0 for empty,
     *     positive for populated). Apify clients should read
     *     `stats.datasetItemCount` below for compat with their schema.
     *
     * A third, defensive case exists: `defaultDatasetId` is set but
     * `defaultDatasetItemCount` is null. The schema has
     * `ON DELETE SET NULL` on the FK (see migrate.ts), so a deleted
     * dataset nulls out the FK column too — this case shouldn't be
     * reachable in practice. The dashboard renders "?" if it ever does,
     * which is a defensive sentinel rather than a routine state.
     */
    defaultDatasetItemCount: row.default_dataset_item_count,
    defaultKeyValueStoreId: row.default_key_value_store_id,
    defaultRequestQueueId: row.default_request_queue_id,
    options: {
      timeoutSecs: row.timeout_secs,
      memoryMbytes: row.memory_mbytes,
    },
    containerUrl: row.container_url,
    buildId: row.build_id,
    buildNumber: row.build_number,
    exitCode: row.exit_code,
    // Apify v2 compat: `stats` carries `datasetItemCount` as a nested
    // field; the top-level `defaultDatasetItemCount` above is convenient
    // for our dashboard but not what apify-client reads. We spread the
    // ingested Crawlee stats first, then overlay the live joined count
    // so the value is always the authoritative `datasets.item_count` —
    // never the potentially-stale `SDK_CRAWLER_STATISTICS_0.requestsFinished`
    // count from the runner-ingested blob.
    stats: {
      ...(row.stats_json ?? {
        inputBodyLen: 0,
        restartCount: 0,
        resurrectCount: 0,
        runTimeSecs:
          row.finished_at && row.started_at
            ? Math.round(
                (new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000
              )
            : 0,
        computeUnits: 0,
      }),
      datasetItemCount: row.default_dataset_item_count ?? 0,
    },
    retryCount: row.retry_count,
    originRunId: row.origin_run_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
