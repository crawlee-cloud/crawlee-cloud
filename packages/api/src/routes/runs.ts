/**
 * Run routes - Apify-compatible endpoints for Actor runs.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query, getClient } from '../db/index.js';
import { redis } from '../storage/redis.js';
import { authenticate } from '../auth/middleware.js';
import { UpdateRunSchema, ListRunsQuerySchema, RunsHistogramQuerySchema } from '../schemas/runs.js';
import { config } from '../config.js';
import { computeYourCostUsd, type CostWindow } from '../lib/run-cost.js';

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

    const result = await query<RunRow>(
      `${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`,
      [runId, request.user!.id]
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    return { data: formatRun(result.rows[0]) };
  });

  /**
   * GET /v2/actor-runs/:runId/cost - Run cost analysis (user-scoped).
   *
   * Actual-overlap attribution: this run's share of the droplet-hours it
   * consumed, split among the runs that actually shared the droplet.
   * Computed on read — never persisted — so still-running siblings (their
   * provisional end is NOW()) and scaler-reaped zombies (finished_at gets
   * backdated) self-correct on the next read. Not part of the Apify v2
   * surface; the dashboard treats it as best-effort decoration.
   */
  fastify.get<{ Params: { runId: string } }>('/actor-runs/:runId/cost', async (request, reply) => {
    const { runId } = request.params;

    const result = await query<{
      id: string;
      status: string;
      started_at: Date | null;
      finished_at: Date | null;
      memory_mbytes: number;
      runner_id: string | null;
      runner_price_hourly: string | null; // pg NUMERIC → string
      runner_provider: string | null;
      default_dataset_item_count: number | null;
    }>(
      `SELECT r.id, r.status, r.started_at, r.finished_at,
                COALESCE(r.memory_mbytes, 1024) AS memory_mbytes,
                r.runner_id, r.runner_price_hourly, r.runner_provider,
                d.item_count AS default_dataset_item_count
         FROM runs r
         LEFT JOIN datasets d ON d.id = r.default_dataset_id
         WHERE r.id = $1 AND r.user_id = $2`,
      [runId, request.user!.id]
    );

    const run = result.rows[0];
    if (!run) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];
    if (!TERMINAL.includes(run.status) || !run.started_at || !run.finished_at) {
      reply.status(400);
      return {
        error: {
          type: 'run-not-finished',
          message: 'Cost analysis is only available for finished runs',
        },
      };
    }

    // Clamp: started_at is stamped by the Postgres clock at claim while
    // finished_at comes from the runner's clock at completion (queue.ts) —
    // skew can make a short run "finish before it starts", which would
    // otherwise yield a negative Apify estimate. computeOverlapCost
    // already self-guards (end <= start → 0).
    const durationHours = Math.max(
      0,
      (run.finished_at.getTime() - run.started_at.getTime()) / 3_600_000
    );
    const computeUnits = (run.memory_mbytes / 1024) * durationHours;
    const apifyCostUsd = computeUnits * config.apifyCuPrice;
    const itemCount = run.default_dataset_item_count ?? 0;
    const priceHourly =
      run.runner_price_hourly === null ? null : parseFloat(run.runner_price_hourly);

    let siblings: CostWindow[] = [];
    if (
      run.runner_provider !== 'local-docker' &&
      run.runner_id &&
      priceHourly !== null &&
      Number.isFinite(priceHourly)
    ) {
      // Siblings across ALL users — droplets are platform-wide. Only
      // window timestamps leave the query; no cross-user data exposure.
      const siblingRes = await query<CostWindow & Record<string, unknown>>(
        `SELECT started_at AS "startedAt", finished_at AS "finishedAt"
           FROM runs
           WHERE runner_id = $1 AND id != $2 AND started_at IS NOT NULL
             AND started_at < $3 AND COALESCE(finished_at, NOW()) > $4`,
        [run.runner_id, run.id, run.finished_at, run.started_at]
      );
      siblings = siblingRes.rows;
    }
    const overlappingRuns = siblings.length;
    const yourCostUsd = computeYourCostUsd(
      {
        runnerProvider: run.runner_provider,
        runnerId: run.runner_id,
        priceHourly,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
      },
      siblings,
      new Date()
    );

    const round6 = (v: number | null): number | null =>
      v === null ? null : Math.round(v * 1e6) / 1e6;
    const per1k = (cost: number | null): number | null =>
      cost === null || itemCount === 0 ? null : (cost / itemCount) * 1000;
    const savingsPct =
      yourCostUsd !== null && apifyCostUsd > 0
        ? Math.round(((apifyCostUsd - yourCostUsd) / apifyCostUsd) * 1000) / 10
        : null;

    return {
      data: {
        yourCostUsd: round6(yourCostUsd),
        apifyCostUsd: round6(apifyCostUsd),
        savingsPct,
        itemCount,
        yourCostPer1kItems: round6(per1k(yourCostUsd)),
        apifyCostPer1kItems: round6(per1k(apifyCostUsd)),
        inputs: {
          runnerProvider: run.runner_provider,
          runnerPriceHourly: priceHourly,
          overlappingRuns,
          apifyCuPrice: config.apifyCuPrice,
          computeUnits: round6(computeUnits),
          durationHours: round6(durationHours),
        },
      },
    };
  });

  /**
   * GET /v2/actor-runs/costs?ids=a,b,c - Batch your-cost for the runs list.
   *
   * Returns only { yourCostUsd } per run — the runs table shows a single
   * compact figure; the full breakdown stays on GET /:runId/cost. Runs that
   * are unknown, another user's, or not yet terminal are silently omitted
   * from the map (best-effort decoration, never an error). Static segment
   * "costs" wins over the :runId param route in find-my-way, so this
   * coexists with GET /actor-runs/:runId like /stats and /histogram do.
   */
  fastify.get<{ Querystring: { ids?: string | string[] } }>(
    '/actor-runs/costs',
    async (request, reply) => {
      // Repeated params (?ids=a&ids=b) parse as an array — normalize instead
      // of letting .split() throw a 500 on a malformed-but-harmless request.
      const idsParam = request.query.ids;
      const idsStr = Array.isArray(idsParam) ? idsParam.join(',') : (idsParam ?? '');
      const ids = [
        ...new Set(
          idsStr
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ];
      if (ids.length === 0) return { data: { costs: {} } };
      if (ids.length > 50) {
        reply.status(400);
        return { error: { type: 'invalid-request', message: 'At most 50 run ids per request' } };
      }

      const runsRes = await query<{
        id: string;
        started_at: Date;
        finished_at: Date;
        runner_id: string | null;
        runner_price_hourly: string | null; // pg NUMERIC → string
        runner_provider: string | null;
      }>(
        `SELECT id, started_at, finished_at, runner_id, runner_price_hourly, runner_provider
         FROM runs
         WHERE id = ANY($1) AND user_id = $2
           AND status IN ('SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED')
           AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
        [ids, request.user!.id]
      );

      // One set-based sibling query for every droplet-attributed run in the
      // batch — same overlap-window predicate as the single-run endpoint,
      // keyed back to its target run. Self-hosted / unrecorded runs skip it.
      const attributed = runsRes.rows.filter(
        (r) =>
          r.runner_provider !== 'local-docker' &&
          r.runner_id !== null &&
          r.runner_price_hourly !== null
      );
      const siblingsByRun = new Map<string, CostWindow[]>();
      if (attributed.length > 0) {
        const sibRes = await query<{ targetId: string } & CostWindow & Record<string, unknown>>(
          `SELECT t.id AS "targetId",
                s.started_at AS "startedAt", s.finished_at AS "finishedAt"
           FROM runs t
           JOIN runs s
             ON s.runner_id = t.runner_id AND s.id != t.id
            AND s.started_at IS NOT NULL
            AND s.started_at < t.finished_at
            AND COALESCE(s.finished_at, NOW()) > t.started_at
          WHERE t.id = ANY($1)`,
          [attributed.map((r) => r.id)]
        );
        for (const row of sibRes.rows) {
          const list = siblingsByRun.get(row.targetId) ?? [];
          list.push({ startedAt: row.startedAt, finishedAt: row.finishedAt });
          siblingsByRun.set(row.targetId, list);
        }
      }

      const now = new Date();
      const costs: Record<string, { yourCostUsd: number | null }> = {};
      for (const run of runsRes.rows) {
        const priceHourly =
          run.runner_price_hourly === null ? null : parseFloat(run.runner_price_hourly);
        const yourCostUsd = computeYourCostUsd(
          {
            runnerProvider: run.runner_provider,
            runnerId: run.runner_id,
            priceHourly,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
          },
          siblingsByRun.get(run.id) ?? [],
          now
        );
        costs[run.id] = {
          yourCostUsd: yourCostUsd === null ? null : Math.round(yourCostUsd * 1e6) / 1e6,
        };
      }
      return { data: { costs } };
    }
  );

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

      // Tell the owning runner to stop the container. Without this the
      // container keeps crawling until natural exit or timeout_secs
      // (default 3600s), and its heartbeat claim blocks scale-down the
      // whole time. Best-effort: the DB status is already terminal, so a
      // failed publish only delays the kill (timeout still bounds it).
      try {
        await redis.publish('run:abort', runId);
      } catch (err) {
        fastify.log.warn(`Failed to publish run:abort for ${runId}: ${(err as Error).message}`);
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
      //
      // Resurrect to READY, not RUNNING: runners claim exclusively
      // `WHERE status = 'READY'` (packages/runner/src/queue.ts). A run
      // resurrected to RUNNING was never picked up by any runner and —
      // because finished_at is NULL — never reaped by retention either:
      // it sat "running" on the dashboard forever.
      const result = await query<RunRow>(
        `
      WITH updated AS (
        UPDATE runs
        -- started_at is cleared too: it belongs to the PREVIOUS attempt.
        -- Leaving it made re-queued runs display a stale "started" while
        -- READY; the claim re-stamps it when a runner picks the run up.
        SET status = 'READY', started_at = NULL, finished_at = NULL,
            exit_code = NULL, status_message = NULL, modified_at = NOW()
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

      // Wake the runners — same signal run creation uses (actors.ts).
      // Without it the resurrected run waits for a runner's next poll.
      try {
        await redis.publish('run:new', runId);
      } catch (err) {
        fastify.log.warn(`Failed to publish run:new for ${runId}: ${(err as Error).message}`);
      }

      return { data: formatRun(result.rows[0]) };
    }
  );

  /**
   * POST /v2/actor-runs/:runId/rerun - Rerun a terminal run as a NEW run
   * (user-scoped).
   *
   * Unlike resurrect (which re-queues the SAME row), rerun clones the
   * origin into a brand-new run: fresh id, fresh dataset/KV/queue, the
   * origin's INPUT bytes, timeout/memory, per-run webhooks, and — when
   * still alive in Redis — its envVars. The origin row is left untouched.
   *
   * Why a new id matters: webhook consumers key their processing on the
   * run id. A downstream ingestion API with a UNIQUE constraint on the
   * run id and create-only semantics consumes the id on the FAILED
   * delivery — every later delivery for that id is dropped. A
   * resurrected run therefore succeeds *silently*: its SUCCEEDED
   * webhook arrives under the consumed id and the data is never
   * ingested. A fresh id makes the rerun indistinguishable from a
   * normal run to every consumer.
   *
   * Fresh storages also mean the rerun starts clean: no partial dataset
   * from the failed attempt to append into, no stale
   * SDK_CRAWLER_STATISTICS_0 for stats ingestion to resurface, and a
   * fresh created_at so bulk reruns queue BEHIND current work instead of
   * FIFO-jumping it (resurrected rows keep their original created_at and
   * instantly trip the claim loop's starvation escalation).
   *
   * One active rerun per chain: a transaction-scoped advisory lock on the
   * chain root plus an active-run check make concurrent POSTs (double
   * click, two tabs, retried request, bulk rerun overlap) deterministic —
   * exactly one clone is created, the rest get 409 rerun-already-active.
   * The check also catches a runner auto-retry already queued for the
   * same chain, so a manual rerun can't duplicate a pending retry.
   */
  fastify.post<{ Params: { runId: string } }>(
    '/actor-runs/:runId/rerun',
    async (request, reply) => {
      const { runId } = request.params;

      // Same terminal-status guard set as resurrect: SUCCEEDED runs are
      // excluded on purpose — "run again after success" is a new-run
      // decision made from the actor page with editable input, not a
      // recovery action.
      const origin = await query<RunRow>(
        `SELECT * FROM runs
          WHERE id = $1 AND status IN ('FAILED', 'ABORTED', 'TIMED-OUT') AND user_id = $2`,
        [runId, request.user!.id]
      );

      if (!origin.rows[0]) {
        reply.status(404);
        return {
          error: {
            type: 'record-not-found',
            message: 'Run not found or not in a rerunnable state',
          },
        };
      }
      const originRun = origin.rows[0];

      // Recover the origin's INPUT before creating anything. Retention
      // reaps unnamed storages independently of runs, so a long-dead
      // origin may have no INPUT left — rerunning with a silently-empty
      // input would "succeed" while scraping nothing. Fail loudly.
      const { getKVRecord, putKVRecord } = await import('../storage/s3.js');
      const inputRecord = originRun.default_key_value_store_id
        ? await getKVRecord(originRun.default_key_value_store_id, 'INPUT')
        : null;

      if (!inputRecord) {
        reply.status(409);
        return {
          error: {
            type: 'input-not-found',
            message:
              "The origin run's INPUT record no longer exists (storage reaped by retention); start a fresh run from the actor page instead",
          },
        };
      }

      // From here on, mirror the creation flow in actors.ts
      // POST /acts/:actorId/runs — fresh storages, INPUT, build stamp.
      const datasetId = nanoid();
      const kvStoreId = nanoid();
      const requestQueueId = nanoid();
      const newRunId = nanoid();

      // origin_run_id collapses chains to the FIRST run (same convention
      // as the runner's retry path): rerun-of-a-rerun still points at the
      // original, so lineage is one hop, never a walk.
      const chainRootId = originRun.origin_run_id ?? originRun.id;

      // Single transaction for storages + run + webhook clones: the
      // runner's POLL loop claims any READY row independently of the
      // run:new notify, so a run row committed before its webhooks would
      // open a window where the rerun executes and finishes silently —
      // the exact failure mode this endpoint exists to eliminate. All-or-
      // nothing also means a mid-flight error leaves no orphaned READY
      // run or storage rows behind.
      const client = await getClient();
      try {
        await client.query('BEGIN');

        // Serialize concurrent reruns of the same chain. Transaction-
        // scoped (auto-released at COMMIT/ROLLBACK) and keyed per chain
        // via hashtextextended, so unrelated reruns never contend. See
        // the lock registry note in db/index.ts.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('rerun:' || $1, 0))`, [
          chainRootId,
        ]);

        // With the lock held, an active-clone check is race-free: a
        // concurrent rerun either committed before us (visible here) or
        // is queued behind the lock. The check covers the chain ROOT
        // itself (id = $1), not just clones — a resurrected root is
        // active without any origin_run_id pointing at it, and resurrect
        // can also flip the origin non-terminal between our pre-lock
        // status read and here. ABORTING counts as active — matches the
        // actor-delete route's definition — so rerunning right after an
        // abort waits for the abort to land.
        const activeClone = await client.query(
          `SELECT 1 FROM runs
            WHERE (origin_run_id = $1 OR id = $1) AND user_id = $2
              AND status IN ('READY', 'RUNNING', 'ABORTING')
            LIMIT 1`,
          [chainRootId, request.user!.id]
        );
        if (activeClone.rows[0]) {
          await client.query('ROLLBACK');
          reply.status(409);
          return {
            error: {
              type: 'rerun-already-active',
              message:
                'A rerun (or auto-retry) of this run is already queued or running; wait for it to finish',
            },
          };
        }

        // KEEP-IN-SYNC: storage trio + INPUT + build stamp mirror the
        // creation flow in actors.ts POST /acts/:actorId/runs.
        await client.query('INSERT INTO datasets (id, user_id) VALUES ($1, $2)', [
          datasetId,
          request.user!.id,
        ]);
        await client.query('INSERT INTO key_value_stores (id, user_id) VALUES ($1, $2)', [
          kvStoreId,
          request.user!.id,
        ]);
        await client.query('INSERT INTO request_queues (id, user_id) VALUES ($1, $2)', [
          requestQueueId,
          request.user!.id,
        ]);

        // Byte-for-byte copy — no parse/re-serialize round-trip that could
        // reorder keys or lose non-JSON content types. Sits inside the
        // transaction window on purpose: if a later insert fails, ROLLBACK
        // removes every row and the S3 object is unreachable garbage at
        // worst (its kvStoreId was never committed).
        await putKVRecord(kvStoreId, 'INPUT', inputRecord.value, inputRecord.contentType);

        // Re-resolve the actor's latest SUCCEEDED build rather than copying
        // the origin's stamp: the runner always executes the current
        // `:latest` image anyway (it never reads build_id), so copying a
        // pre-rebuild stamp would make the run row lie about what ran.
        const buildLookup = await client.query<{ build_id: string; version_number: string | null }>(
          `SELECT b.id AS build_id, v.version_number
             FROM actor_builds b
             LEFT JOIN actor_versions v ON v.id = b.version_id
            WHERE b.actor_id = $1 AND b.status = 'SUCCEEDED'
            ORDER BY b.created_at DESC
            LIMIT 1`,
          [originRun.actor_id]
        );
        const buildId = buildLookup.rows[0]?.build_id ?? null;
        const buildNumber = buildLookup.rows[0]?.version_number ?? null;

        const result = await client.query<RunRow>(
          `
          WITH inserted AS (
            INSERT INTO runs (id, actor_id, user_id, status, default_dataset_id, default_key_value_store_id, default_request_queue_id, timeout_secs, memory_mbytes, build_id, build_number, origin_run_id)
            VALUES ($1, $2, $3, 'READY', $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
          )
          SELECT r.*, d.item_count AS default_dataset_item_count
          FROM inserted r
          LEFT JOIN datasets d ON d.id = r.default_dataset_id
        `,
          [
            newRunId,
            originRun.actor_id,
            request.user!.id,
            datasetId,
            kvStoreId,
            requestQueueId,
            originRun.timeout_secs,
            originRun.memory_mbytes,
            buildId,
            buildNumber,
            chainRootId,
          ]
        );

        // Copy the origin's per-run webhooks onto the new id — the whole
        // point of rerun-as-new-run. The runner's webhook match filters
        // `run_id = <current run>` and never consults origin_run_id, so
        // without this copy the rerun would finish silently. (The runner's
        // auto-retry path has exactly that latent bug; see roadmap.)
        // user_id-scoped for defense in depth: today run-scoped webhooks
        // always belong to the run's owner, but this SELECT must never
        // become the query that copies another tenant's webhook (and its
        // auth headers) if that invariant ever loosens.
        //
        // The column list is every user-authored column on the table, not
        // just the ones reachable today: `description` is always NULL on a
        // run-scoped row right now (run-start payloads have no description
        // field, and PUT /v2/webhooks/:id refuses run-scoped rows to keep
        // them immutable post-dispatch), but the day either of those
        // loosens, a clone that silently drops it is a bug nobody would
        // think to look for here. Copying NULL costs nothing.
        const originWebhooks = await client.query<{
          user_id: string | null;
          event_types: string[];
          request_url: string;
          payload_template: string | null;
          headers: Record<string, string> | null;
          is_enabled: boolean;
          description: string | null;
        }>(
          `SELECT user_id, event_types, request_url, payload_template, headers, is_enabled, description
             FROM webhooks WHERE run_id = $1 AND user_id = $2`,
          [runId, request.user!.id]
        );
        for (const wh of originWebhooks.rows) {
          await client.query(
            `INSERT INTO webhooks (id, user_id, event_types, request_url, payload_template, run_id, headers, is_enabled, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              nanoid(),
              wh.user_id,
              wh.event_types,
              wh.request_url,
              wh.payload_template,
              newRunId,
              wh.headers ? JSON.stringify(wh.headers) : null,
              wh.is_enabled,
              wh.description,
            ]
          );
        }

        // Carry runtime env vars over while the origin's Redis key is
        // still alive (24h TTL, set at creation). Two distinct cases:
        // key ABSENT (TTL expired) → proceed without env vars, same
        // behavior the runner has for an expired key; Redis ERROR → let
        // it throw so the outer catch rolls the clone back. We can't
        // know whether env vars existed, and a container started without
        // them (proxy credentials!) fails late instead of loud — the
        // caller can just retry the POST once Redis is back. That also
        // matches run creation, where the envVars SET is likewise
        // unguarded (actors.ts POST /acts/:actorId/runs): a Redis outage
        // fails the request rather than producing a half-provisioned run.
        // Copied BEFORE COMMIT on purpose: the runner's poll loop can
        // claim the READY row the instant it's visible. On ROLLBACK the
        // stray key is 24h unreachable garbage — same argument as the
        // S3 INPUT above.
        const envVars = await redis.get(`run:${runId}:envVars`);
        if (envVars) {
          await redis.set(`run:${newRunId}:envVars`, envVars, 'EX', 86400);
        }

        await client.query('COMMIT');

        // Wake the runners — same signal run creation uses. The webhook
        // clones are already committed, so a runner claiming instantly
        // still delivers them.
        try {
          await redis.publish('run:new', newRunId);
        } catch (err) {
          fastify.log.warn(`Failed to publish run:new for ${newRunId}: ${(err as Error).message}`);
        }

        reply.status(201);
        return { data: formatRun(result.rows[0]!) };
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors if transaction was already aborted or connection closed
        }
        throw err;
      } finally {
        client.release();
      }
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

    const run = await query<RunRow>(
      `${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`,
      [runId, request.user!.id]
    );

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

      const run = await query<RunRow>(
        `${RUN_SELECT_WITH_DATASET_COUNT} WHERE r.id = $1 AND r.user_id = $2`,
        [runId, request.user!.id]
      );

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
