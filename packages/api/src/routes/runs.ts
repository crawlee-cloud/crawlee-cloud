/**
 * Run routes - Apify-compatible endpoints for Actor runs.
 */

import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';
import { UpdateRunSchema, ListRunsQuerySchema } from '../schemas/runs.js';

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
}

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
    const where: string[] = ['user_id = $1'];
    const params: unknown[] = [request.user!.id];
    let p = 2;
    if (q.status !== undefined) {
      where.push(`status = $${p++}`);
      params.push(q.status);
    }
    if (q.actorId !== undefined) {
      where.push(`actor_id = $${p++}`);
      params.push(q.actorId);
    }
    if (q.since !== undefined) {
      where.push(`created_at >= $${p++}`);
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push(`created_at < $${p++}`);
      params.push(q.until);
    }
    const whereSql = where.join(' AND ');

    // COUNT and SELECT run in parallel — both share the same composite index
    // so the count query is cheap up to ~hundreds of thousands of rows.
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM runs WHERE ${whereSql}`,
        params
      ),
      query<RunRow>(
        // Stable tiebreaker on `id`. Without it, LIMIT/OFFSET pagination
        // can drop or duplicate rows when two runs share the exact same
        // created_at (ms-precision ties are realistic at 140 scrapers ×
        // burst writes — Postgres doesn't guarantee row order on ties).
        `SELECT * FROM runs WHERE ${whereSql}
         ORDER BY created_at ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'}
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
   * GET /v2/actor-runs/:runId - Get run (user-scoped)
   */
  fastify.get<{ Params: { runId: string } }>('/actor-runs/:runId', async (request, reply) => {
    const { runId } = request.params;

    const result = await query<RunRow>('SELECT * FROM runs WHERE id = $1 AND user_id = $2', [
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
    const result = await query<RunRow>(
      `
      UPDATE runs SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
      RETURNING *
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

      const result = await query<RunRow>(
        `
      UPDATE runs
      SET status = 'ABORTED', finished_at = NOW(), modified_at = NOW()
      WHERE id = $1 AND status = 'RUNNING' AND user_id = $2
      RETURNING *
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

      const result = await query<RunRow>(
        `
      UPDATE runs
      SET status = 'RUNNING', finished_at = NULL, modified_at = NOW()
      WHERE id = $1 AND status IN ('FAILED', 'ABORTED', 'TIMED-OUT') AND user_id = $2
      RETURNING *
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

    const run = await query<RunRow>('SELECT * FROM runs WHERE id = $1 AND user_id = $2', [
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

      const run = await query<RunRow>('SELECT * FROM runs WHERE id = $1 AND user_id = $2', [
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
    stats: row.stats_json ?? {
      // Default stats structure
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
    },
    retryCount: row.retry_count,
    originRunId: row.origin_run_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
