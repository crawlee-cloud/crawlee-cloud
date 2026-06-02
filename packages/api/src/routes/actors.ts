/**
 * Actor routes - Apify-compatible endpoints for managing Actors.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { CreateActorSchema, UpdateActorSchema, ActorRunSchema } from '../schemas/actors.js';
import { query } from '../db/index.js';
import { encryptProxyPassword } from '../lib/proxy-crypto.js';
import { appendSearchCondition } from '../db/search.js';
import { redis } from '../storage/redis.js';
import { authenticate } from '../auth/middleware.js';

interface ActorRow {
  id: string;
  name: string;
  user_id: string | null;
  title: string | null;
  description: string | null;
  default_run_options: Record<string, unknown> | null;
  max_retries: number;
  retry_delay_secs: number;
  proxy_password_encrypted: string | null;
  created_at: Date;
  modified_at: Date;
}

/**
 * Find or create the actor_versions row for a given (actor, version) pair.
 * Apify's data model:
 *   - version (e.g. "0.0", "1.2") = immutable source-version concept,
 *     matching .actor/actor.json `version`
 *   - build_tag (e.g. "latest", "beta") = mutable pointer to a specific
 *     build of that version. Running `actor:latest` resolves through the
 *     tag to the underlying build, so the tag is the "current pointer"
 *     while builds accumulate as immutable history.
 *
 * Default tag is "latest" — same convention Docker uses, and what users
 * implicitly want when they run an actor without specifying a tag.
 */
async function findOrCreateActorVersion(
  actorId: string,
  versionNumber: string,
  buildTag = 'latest'
): Promise<string | null> {
  // The tag is a single moving pointer per actor. Claiming it must
  // happen for BOTH paths — newly created versions AND existing ones
  // being re-pushed (rollback). Otherwise pushing v1 after v2 leaves
  // current_version_id=v1 but build_tag=latest still on v2 — two
  // sources of truth disagreeing on which build is current. Tests for
  // this in test/integration/runs-list and the codex review on PR #18
  // both flagged it.
  //
  // We claim-and-clear in a single statement so the tag is never on
  // zero versions or two simultaneously.
  const existing = await query<{ id: string }>(
    `WITH cleared AS (
       UPDATE actor_versions SET build_tag = NULL
       WHERE actor_id = $1 AND build_tag = $3 AND version_number <> $2
     )
     UPDATE actor_versions SET build_tag = $3
     WHERE actor_id = $1 AND version_number = $2
     RETURNING id`,
    [actorId, versionNumber, buildTag]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  // Version doesn't exist yet — insert claiming the tag, clearing siblings.
  const id = nanoid();
  const inserted = await query<{ id: string }>(
    `WITH cleared AS (
       UPDATE actor_versions SET build_tag = NULL
       WHERE actor_id = $2 AND build_tag = $4 AND version_number <> $3
     )
     INSERT INTO actor_versions (id, actor_id, version_number, build_tag)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor_id, version_number) DO UPDATE SET version_number = EXCLUDED.version_number
     RETURNING id`,
    [id, actorId, versionNumber, buildTag]
  );
  return inserted.rows[0]?.id ?? null;
}

/**
 * Record a SUCCEEDED build row whenever an actor is registered/updated with
 * a new (version, image) combination. This captures the *deploy event* — the
 * CLI built the image locally and is now telling the platform "this image
 * is version X". Populates the dashboard's /builds page.
 *
 * Dedup key: (version_number, image_name). Same version + same image is
 * idempotent (no row); same version + new image is a rebuild (new row under
 * the existing version); new version is its own version row + first build.
 *
 * Falls back to "no version" when the CLI didn't send one — the build still
 * gets recorded, just with `version_id = NULL`. That keeps backward compat
 * for any caller still on the older payload shape.
 *
 * Best-effort: failures are logged and swallowed. The actor upsert is the
 * user's actual intent; a missing build row is a UI nicety, not a
 * correctness issue.
 */
async function recordBuildIfNew(
  actorId: string,
  defaultRunOptions: unknown,
  versionNumber: string | undefined,
  log: (msg: string) => void = () => undefined
): Promise<void> {
  if (!defaultRunOptions || typeof defaultRunOptions !== 'object') return;
  const imageName = (defaultRunOptions as { image?: unknown }).image;
  if (typeof imageName !== 'string' || imageName.length === 0) return;

  try {
    const versionId = versionNumber ? await findOrCreateActorVersion(actorId, versionNumber) : null;

    // Dedup: skip if the most recent build for this actor already matches
    // both image and version. Older builds (different versions) stay on
    // record so the page shows full history.
    const existing = await query<{ image_name: string | null; version_id: string | null }>(
      `SELECT image_name, version_id FROM actor_builds
       WHERE actor_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [actorId]
    );
    const last = existing.rows[0];
    if (last && last.image_name === imageName && (last.version_id ?? null) === versionId) {
      return;
    }

    await query(
      `INSERT INTO actor_builds
         (id, actor_id, version_id, status, image_name, started_at, finished_at)
       VALUES ($1, $2, $3, 'SUCCEEDED', $4, NOW(), NOW())`,
      [nanoid(), actorId, versionId, imageName]
    );

    // Bubble the most-recent version up to the actor row so consumers
    // (dashboard, runner) can find "the current source version" without
    // joining through builds.
    if (versionId) {
      await query(`UPDATE actors SET current_version_id = $1, modified_at = NOW() WHERE id = $2`, [
        versionId,
        actorId,
      ]);
    }
  } catch (err) {
    log(`recordBuildIfNew failed for ${actorId}: ${(err as Error).message}`);
  }
}

export const actorsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/acts - List actors (filtered by user)
   *
   * Apify-shaped pagination: { data: { total, count, offset, limit, items } }
   * where `total` is the real row count from a parallel COUNT(*) query and
   * `count` is the length of the returned page. The previous version
   * hardcoded LIMIT 100 in SQL, ignored the ?limit/?offset query params,
   * and returned `total = result.rows.length` (always ≤ 100). Consumers
   * trusting `total` concluded there were exactly 100 actors no matter
   * how many actually existed.
   *
   * Mirrors the pattern in runs.ts and datasets.ts.
   */
  fastify.get<{
    Querystring: { offset?: string; limit?: string; q?: string };
  }>('/acts', async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const params: unknown[] = [request.user!.id];
    const where = appendSearchCondition('user_id = $1', params, request.query.q || '', [
      'id',
      'name',
      'title',
      'description',
    ]);

    // COUNT and SELECT run in parallel. Stable tiebreaker on `id` so
    // LIMIT/OFFSET paging doesn't drop or duplicate rows when two actors
    // share the same created_at (ms-precision ties happen on bulk imports).
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM actors WHERE ${where}`, params),
      query<ActorRow>(
        `SELECT * FROM actors WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
        items: pageResult.rows.map(formatActor),
      },
    };
  });

  /**
   * POST /v2/acts - Create or update actor (upsert by name)
   */
  fastify.post<{
    Body: {
      name: string;
      title?: string;
      description?: string;
      defaultRunOptions?: Record<string, unknown>;
      maxRetries?: number;
      retryDelaySecs?: number;
      proxyPassword?: string | null;
    };
  }>('/acts', async (request, reply) => {
    const {
      name,
      title,
      description,
      defaultRunOptions,
      maxRetries,
      retryDelaySecs,
      version,
      proxyPassword,
    } = CreateActorSchema.parse(request.body);

    // Three-state proxyPassword semantics matching PUT /v2/acts/:id:
    //   undefined → preserve existing (update) / null on insert
    //   null      → explicit clear
    //   string    → encrypt + store
    const encryptIfSet = (v: string | null | undefined): string | null | undefined =>
      v === undefined ? undefined : v === null ? null : encryptProxyPassword(v);

    // Check if actor with this name already exists for this user
    const existing = await query<ActorRow>(
      'SELECT * FROM actors WHERE name = $1 AND user_id = $2',
      [name, request.user!.id]
    );

    if (existing.rows[0]) {
      // Update existing actor (user_id already verified in SELECT)
      const proxyParam = encryptIfSet(proxyPassword);
      const result = await query<ActorRow>(
        `
        UPDATE actors
        SET title = $1, description = $2, default_run_options = $3,
            max_retries = $4, retry_delay_secs = $5,
            proxy_password_encrypted = $6, modified_at = NOW()
        WHERE name = $7 AND user_id = $8
        RETURNING *
      `,
        [
          title ?? existing.rows[0].title,
          description ?? existing.rows[0].description,
          defaultRunOptions
            ? JSON.stringify(defaultRunOptions)
            : existing.rows[0].default_run_options,
          maxRetries ?? existing.rows[0].max_retries,
          retryDelaySecs ?? existing.rows[0].retry_delay_secs,
          proxyParam === undefined ? existing.rows[0].proxy_password_encrypted : proxyParam,
          name,
          request.user!.id,
        ]
      );

      // Record the deploy if the CLI sent a new image reference.
      await recordBuildIfNew(
        result.rows[0]!.id,
        defaultRunOptions ?? existing.rows[0].default_run_options,
        version,
        (m) => fastify.log.warn(m)
      );
      return { data: formatActor(result.rows[0]!) };
    }

    // Create new actor with user ownership
    const id = nanoid();
    const result = await query<ActorRow>(
      `
      INSERT INTO actors (id, name, user_id, title, description, default_run_options, max_retries, retry_delay_secs, proxy_password_encrypted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
      [
        id,
        name,
        request.user!.id,
        title ?? null,
        description ?? null,
        defaultRunOptions ? JSON.stringify(defaultRunOptions) : null,
        maxRetries ?? 0,
        retryDelaySecs ?? 60,
        encryptIfSet(proxyPassword) ?? null,
      ]
    );

    await recordBuildIfNew(id, defaultRunOptions, version, (m) => fastify.log.warn(m));
    reply.status(201);
    return { data: formatActor(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId - Get actor (user-scoped)
   */
  fastify.get<{ Params: { actorId: string } }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;

    // Get actor by ID or name, scoped to user
    const result = await query<ActorRow>(
      `SELECT * FROM actors WHERE (id = $1 OR name = $1) AND user_id = $2`,
      [actorId, request.user!.id]
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }

    return { data: formatActor(result.rows[0]) };
  });

  /**
   * PUT /v2/acts/:actorId - Update actor
   */
  fastify.put<{
    Params: { actorId: string };
    Body: {
      name?: string;
      title?: string;
      description?: string;
      defaultRunOptions?: Record<string, unknown>;
      maxRetries?: number;
      retryDelaySecs?: number;
      proxyPassword?: string | null;
    };
  }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;
    const updates = UpdateActorSchema.parse(request.body);

    const setClauses: string[] = ['modified_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.title !== undefined) {
      setClauses.push(`title = $${paramIndex++}`);
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.defaultRunOptions !== undefined) {
      setClauses.push(`default_run_options = $${paramIndex++}`);
      values.push(JSON.stringify(updates.defaultRunOptions));
    }
    if (updates.maxRetries !== undefined) {
      setClauses.push(`max_retries = $${paramIndex++}`);
      values.push(updates.maxRetries);
    }
    if (updates.retryDelaySecs !== undefined) {
      setClauses.push(`retry_delay_secs = $${paramIndex++}`);
      values.push(updates.retryDelaySecs);
    }
    if (updates.proxyPassword !== undefined) {
      setClauses.push(`proxy_password_encrypted = $${paramIndex++}`);
      values.push(
        updates.proxyPassword === null ? null : encryptProxyPassword(updates.proxyPassword)
      );
    }

    values.push(actorId);
    const actorIdParam = paramIndex++;
    values.push(request.user!.id);
    const userIdParam = paramIndex++;

    const result = await query<ActorRow>(
      `
      UPDATE actors SET ${setClauses.join(', ')}
      WHERE (id = $${actorIdParam} OR name = $${actorIdParam}) AND user_id = $${userIdParam}
      RETURNING *
    `,
      values
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }

    if (updates.defaultRunOptions !== undefined || updates.version !== undefined) {
      await recordBuildIfNew(
        result.rows[0].id,
        updates.defaultRunOptions ?? result.rows[0].default_run_options,
        updates.version,
        (m) => fastify.log.warn(m)
      );
    }

    return { data: formatActor(result.rows[0]) };
  });

  /**
   * DELETE /v2/acts/:actorId - Delete actor (user-scoped)
   */
  fastify.delete<{ Params: { actorId: string } }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;
    const result = await query(
      `DELETE FROM actors WHERE (id = $1 OR name = $1) AND user_id = $2 RETURNING id`,
      [actorId, request.user!.id]
    );
    if (result.rowCount === 0) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }
    reply.status(204);
  });

  /**
   * POST /v2/acts/:actorId/runs - Start actor run
   */
  fastify.post<{
    Params: { actorId: string };
    Body: {
      input?: unknown;
      timeout?: number;
      memory?: number;
      envVars?: Record<string, string>;
      webhooks?: Array<{
        eventTypes: string[];
        requestUrl: string;
        payloadTemplate?: string;
        headersTemplate?: string;
      }>;
    };
  }>('/acts/:actorId/runs', async (request, reply) => {
    const { actorId } = request.params;
    const {
      input,
      timeout = 3600,
      memory = 1024,
      envVars,
      webhooks,
    } = ActorRunSchema.parse(request.body || {});

    // Get actor by ID or name, scoped to user
    const actor = await query<ActorRow>(
      `SELECT * FROM actors WHERE (id = $1 OR name = $1) AND user_id = $2`,
      [actorId, request.user!.id]
    );

    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }

    // Create default storages for this run
    const datasetId = nanoid();
    const kvStoreId = nanoid();
    const requestQueueId = nanoid();
    const runId = nanoid();

    // Create storages with user ownership
    await query('INSERT INTO datasets (id, user_id) VALUES ($1, $2)', [
      datasetId,
      request.user!.id,
    ]);
    await query('INSERT INTO key_value_stores (id, user_id) VALUES ($1, $2)', [
      kvStoreId,
      request.user!.id,
    ]);
    await query('INSERT INTO request_queues (id, user_id) VALUES ($1, $2)', [
      requestQueueId,
      request.user!.id,
    ]);

    // Always store input in the KV store (empty object if not provided)
    const { putKVRecord } = await import('../storage/s3.js');
    await putKVRecord(kvStoreId, 'INPUT', JSON.stringify(input ?? {}), 'application/json');

    // Stamp the run with the actor's most recent SUCCEEDED build so the
    // run row (and downstream webhook resource block) carries buildId /
    // buildNumber instead of null. NULL stays valid for actors that have
    // never been pushed — the runs API and webhook payload both tolerate
    // it. Joined to actor_versions for the human-readable version_number.
    const buildLookup = await query<{ build_id: string; version_number: string | null }>(
      `SELECT b.id AS build_id, v.version_number
         FROM actor_builds b
         LEFT JOIN actor_versions v ON v.id = b.version_id
        WHERE b.actor_id = $1 AND b.status = 'SUCCEEDED'
        ORDER BY b.created_at DESC
        LIMIT 1`,
      [actor.rows[0].id]
    );
    const buildId = buildLookup.rows[0]?.build_id ?? null;
    const buildNumber = buildLookup.rows[0]?.version_number ?? null;

    // Create run record with READY status so Runner picks it up (with user ownership)
    const result = await query<{
      id: string;
      actor_id: string;
      status: string;
      started_at: Date;
      default_dataset_id: string;
      default_key_value_store_id: string;
      default_request_queue_id: string;
      timeout_secs: number;
      memory_mbytes: number;
      created_at: Date;
    }>(
      `
      INSERT INTO runs (id, actor_id, user_id, status, default_dataset_id, default_key_value_store_id, default_request_queue_id, timeout_secs, memory_mbytes, build_id, build_number)
      VALUES ($1, $2, $3, 'READY', $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
      [
        runId,
        actor.rows[0].id,
        request.user!.id,
        datasetId,
        kvStoreId,
        requestQueueId,
        timeout,
        memory,
        buildId,
        buildNumber,
      ]
    );

    // Store runtime env vars in Redis if provided
    if (envVars && Object.keys(envVars).length > 0) {
      await redis.set(`run:${runId}:envVars`, JSON.stringify(envVars), 'EX', 86400);
    }

    // Persist per-run webhooks. Inserted as rows in the existing `webhooks`
    // table with run_id set so the runner's match query unions them in
    // alongside admin-configured (actor-scoped or global) webhooks. Headers
    // arrive Apify-shape as a JSON-string `headersTemplate` and are parsed
    // once at INSERT — Crawlee Cloud doesn't yet run header values through
    // the templating engine. Known SDK clients don't use {{vars}} in headers,
    // so this is non-blocking; full templating is tracked as a TODO in
    // docs/apify-compatibility.md.
    if (Array.isArray(webhooks) && webhooks.length > 0) {
      const persistedRunId = result.rows[0]!.id;
      for (const wh of webhooks) {
        let parsedHeaders: Record<string, string> | null = null;
        if (wh.headersTemplate) {
          try {
            parsedHeaders = JSON.parse(wh.headersTemplate) as Record<string, string>;
          } catch {
            // Malformed headersTemplate — webhook delivers without those headers,
            // operator can inspect via webhook_deliveries.
            parsedHeaders = null;
          }
        }
        await query(
          `INSERT INTO webhooks (id, user_id, event_types, request_url, payload_template, run_id, headers, is_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [
            nanoid(),
            request.user!.id,
            wh.eventTypes,
            wh.requestUrl,
            wh.payloadTemplate ?? null,
            persistedRunId,
            parsedHeaders ? JSON.stringify(parsedHeaders) : null,
          ]
        );
      }
    }

    // Notify Runner about new job
    await redis.publish('run:new', runId);

    reply.status(201);
    return {
      data: {
        id: result.rows[0]!.id,
        actId: actor.rows[0].id,
        status: result.rows[0]!.status,
        startedAt: result.rows[0]!.started_at,
        defaultDatasetId: datasetId,
        defaultKeyValueStoreId: kvStoreId,
        defaultRequestQueueId: requestQueueId,
      },
    };
  });

  /**
   * POST /v2/acts/:actorId/run-sync - Run actor and wait for finish
   * (Simplified version - in production would need actual container execution)
   */
  fastify.post<{
    Params: { actorId: string };
    Body: { input?: unknown };
  }>('/acts/:actorId/run-sync', async (request, _reply) => {
    // For now, just create the run - actual execution would be handled by runner service
    return (fastify as any).inject({
      method: 'POST',
      url: `/v2/acts/${request.params.actorId}/runs`,
      payload: request.body,
    });
  });
};

function formatActor(row: ActorRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    defaultRunOptions: row.default_run_options,
    maxRetries: row.max_retries,
    retryDelaySecs: row.retry_delay_secs,
    hasProxyOverride: row.proxy_password_encrypted !== null,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
