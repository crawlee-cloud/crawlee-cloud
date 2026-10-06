/**
 * Actor routes - Apify-compatible endpoints for managing Actors.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  CreateActorSchema,
  UpdateActorSchema,
  DeleteActorQuerySchema,
  type ActorDefinition,
} from '../schemas/actors.js';
import { ListRunsQuerySchema } from '../schemas/runs.js';
import { listRuns, loadRun, formatRun } from './runs.js';
import { parseRunStartRequest, isUnsupportedRunContentType } from '../lib/run-body.js';
import {
  waitForTerminal,
  createWaitAbortFactory,
  isTerminalStatus,
  markLongPoll,
} from '../lib/wait-for-terminal.js';
import { query, getClient } from '../db/index.js';
import { encryptProxyPassword } from '../lib/proxy-crypto.js';
import { appendSearchCondition } from '../db/search.js';
import { redis } from '../storage/redis.js';
import { authenticate } from '../auth/middleware.js';
import { resolveActor, ACTOR_NOT_FOUND, type ActorRow } from '../lib/resolve-actor.js';

/** ActorRow as returned by the queries below, with the owner's username. */
type ActorRowWithUsername = ActorRow & { username: string | null };

/** ActorRow plus the list-only columns of GET /v2/acts. */
type ActorListRow = ActorRowWithUsername & { last_run_started_at: Date | null };

// Appended to RETURNING * so POST/PUT responses carry the owner's username
// without a second round trip (RETURNING can't join).
const RETURNING_WITH_USERNAME = `RETURNING *, (SELECT username FROM users WHERE users.id = actors.user_id) AS username`;

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
  // Clear first, then claim, as two statements. A single statement (the
  // clear in a data-modifying CTE) can't be used here: both UPDATEs run on
  // the same snapshot in an unspecified order, and when the claim runs
  // first it violates the unique (actor_id, build_tag) index, so the
  // rollback re-push silently recorded no build (#117). In between, the
  // tag is on no version; the default-build lookup then falls back to the
  // actor's newest SUCCEEDED build.
  await query(
    `UPDATE actor_versions SET build_tag = NULL
     WHERE actor_id = $1 AND build_tag = $3 AND version_number <> $2`,
    [actorId, versionNumber, buildTag]
  );
  const existing = await query<{ id: string }>(
    `UPDATE actor_versions SET build_tag = $3
     WHERE actor_id = $1 AND version_number = $2
     RETURNING id`,
    [actorId, versionNumber, buildTag]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  // Version doesn't exist yet — insert claiming the tag (siblings were
  // cleared above).
  const id = nanoid();
  const inserted = await query<{ id: string }>(
    `INSERT INTO actor_versions (id, actor_id, version_number, build_tag)
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
 * actorDefinition (input schema, README — #112) lives on the build row:
 *   - a new build stores the definition sent with it, or, when none was sent
 *     (older CLI, plain image re-push), carries over the previous build's so
 *     MCP tools generated from it don't disappear;
 *   - a deduped (same image + version) deploy updates the latest build's
 *     definition in place when one was sent, and leaves it alone otherwise.
 * The definition is written in the same statement as the insert/update, so a
 * build can never end up without the definition its request carried.
 *
 * Best-effort: failures are logged and swallowed. The actor upsert is the
 * user's actual intent; a missing build row is a UI nicety, not a
 * correctness issue.
 */
async function recordBuildIfNew(
  actorId: string,
  defaultRunOptions: unknown,
  versionNumber: string | undefined,
  log: (msg: string) => void = () => undefined,
  actorDefinition?: ActorDefinition
): Promise<void> {
  const imageName = imageOf(defaultRunOptions);
  if (!imageName) return;
  const definitionJson = actorDefinition === undefined ? null : JSON.stringify(actorDefinition);

  try {
    const versionId = versionNumber ? await findOrCreateActorVersion(actorId, versionNumber) : null;

    // Dedup: skip if the most recent build for this actor already matches
    // both image and version. Older builds (different versions) stay on
    // record so the page shows full history.
    const existing = await query<{
      id: string;
      image_name: string | null;
      version_id: string | null;
    }>(
      `SELECT id, image_name, version_id FROM actor_builds
       WHERE actor_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [actorId]
    );
    const last = existing.rows[0];
    // A definition-only update (no version sent) targets the latest build
    // whatever its version — otherwise a PUT of just { actorDefinition }
    // against a versioned build would mint a duplicate version-less build.
    const versionMatches =
      versionNumber === undefined && definitionJson !== null
        ? true
        : (last?.version_id ?? null) === versionId;
    if (last && last.image_name === imageName && versionMatches) {
      if (definitionJson !== null) {
        // COALESCE keeps the stored definition if this ever runs without one.
        await query(
          `UPDATE actor_builds SET actor_definition = COALESCE($2::jsonb, actor_definition)
           WHERE id = $1`,
          [last.id, definitionJson]
        );
      }
      return;
    }

    // No definition sent → inherit the previous build's (subquery runs
    // before the new row exists, so "latest" is the previous build). $2 is
    // cast in both places so Postgres deduces one type for it.
    await query(
      `INSERT INTO actor_builds
         (id, actor_id, version_id, status, image_name, started_at, finished_at, actor_definition)
       VALUES ($1, $2::varchar, $3, 'SUCCEEDED', $4, NOW(), NOW(),
         COALESCE($5::jsonb, (
           SELECT actor_definition FROM actor_builds
            WHERE actor_id = $2::varchar
            ORDER BY created_at DESC
            LIMIT 1
         )))`,
      [nanoid(), actorId, versionId, imageName, definitionJson]
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

/** The image reference from a default_run_options value, if it has one. */
function imageOf(defaultRunOptions: unknown): string | undefined {
  if (!defaultRunOptions || typeof defaultRunOptions !== 'object') return undefined;
  const image = (defaultRunOptions as { image?: unknown }).image;
  return typeof image === 'string' && image.length > 0 ? image : undefined;
}

// actorDefinition is stored on a build row, and builds only exist for actors
// with an image. Reject rather than silently dropping the definition.
const DEFINITION_REQUIRES_IMAGE = {
  error: { type: 'validation_error', message: 'actorDefinition requires an image' },
};

/**
 * Options shared by the actor-scoped plugins (`actorsRoutes`, `registryRoutes`).
 *
 * apify-client >= 2.23.4 addresses actors as `/v2/actors/...`; older clients,
 * the CLI and the dashboard use `/v2/acts/...`. Both plugins are plain
 * encapsulated plugins (no decorators, no module state), so
 * `registerV2Routes` registers each one twice, once per segment, and every
 * route added here is served under both paths without duplicating handlers.
 * Defaults to `acts` (and `opts` to `{}`, for callers that invoke the plugin
 * function directly).
 */
export interface ActorsSegmentOptions {
  actorsSegment?: 'acts' | 'actors';
}

export const actorsRoutes: FastifyPluginAsync<ActorsSegmentOptions> = async (
  fastify,
  opts = {}
) => {
  const segment = opts.actorsSegment ?? 'acts';
  fastify.addHook('preHandler', authenticate);
  const waitAbortSignal = createWaitAbortFactory(fastify);

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
    // `my=1` (sent by the Apify MCP get-actor-list) is accepted and ignored:
    // lists are always the caller's own actors.
    Querystring: { offset?: string; limit?: string; q?: string; my?: string };
  }>(`/${segment}`, async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const params: unknown[] = [request.user!.id];
    const where = appendSearchCondition('a.user_id = $1', params, request.query.q || '', [
      'a.id',
      'a.name',
      'a.title',
      'a.description',
    ]);

    // COUNT and SELECT run in parallel. Stable tiebreaker on `id` so
    // LIMIT/OFFSET paging doesn't drop or duplicate rows when two actors
    // share the same created_at (ms-precision ties happen on bulk imports).
    //
    // `stats.lastRunStartedAt` is the newest run per actor. The lateral
    // subquery filters on user_id as well as actor_id so it walks
    // idx_runs_user_actor_created (user_id, actor_id, created_at DESC) —
    // there's no index on runs.actor_id alone.
    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM actors a WHERE ${where}`,
        params
      ),
      query<ActorListRow>(
        `SELECT a.*, u.username, lr.created_at AS last_run_started_at
           FROM actors a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN LATERAL (
             SELECT r.created_at FROM runs r
              WHERE r.user_id = a.user_id AND r.actor_id = a.id
              ORDER BY r.created_at DESC
              LIMIT 1
           ) lr ON true
          WHERE ${where}
          ORDER BY a.created_at DESC, a.id DESC
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
        items: pageResult.rows.map((row) => ({
          ...formatActor(row),
          stats: { lastRunStartedAt: row.last_run_started_at ?? null },
        })),
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
  }>(`/${segment}`, async (request, reply) => {
    const {
      name,
      title,
      description,
      defaultRunOptions,
      maxRetries,
      retryDelaySecs,
      version,
      proxyPassword,
      actorDefinition,
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

    if (
      actorDefinition !== undefined &&
      !imageOf(defaultRunOptions ?? existing.rows[0]?.default_run_options)
    ) {
      reply.status(400);
      return DEFINITION_REQUIRES_IMAGE;
    }

    if (existing.rows[0]) {
      // Update existing actor (user_id already verified in SELECT)
      const proxyParam = encryptIfSet(proxyPassword);
      const result = await query<ActorRowWithUsername>(
        `
        UPDATE actors
        SET title = $1, description = $2, default_run_options = $3,
            max_retries = $4, retry_delay_secs = $5,
            proxy_password_encrypted = $6, modified_at = NOW()
        WHERE name = $7 AND user_id = $8
        ${RETURNING_WITH_USERNAME}
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
        (m) => fastify.log.warn(m),
        actorDefinition
      );
      return { data: formatActor(result.rows[0]!) };
    }

    // Create new actor with user ownership
    const id = nanoid();
    const result = await query<ActorRowWithUsername>(
      `
      INSERT INTO actors (id, name, user_id, title, description, default_run_options, max_retries, retry_delay_secs, proxy_password_encrypted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ${RETURNING_WITH_USERNAME}
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

    await recordBuildIfNew(
      id,
      defaultRunOptions,
      version,
      (m) => fastify.log.warn(m),
      actorDefinition
    );
    reply.status(201);
    return { data: formatActor(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId - Get actor (user-scoped)
   */
  fastify.get<{ Params: { actorId: string } }>(`/${segment}/:actorId`, async (request, reply) => {
    const { actorId } = request.params;

    // Get actor by ID, name or username~name, scoped to user
    const actor = await resolveActor(actorId, request.user!.id);

    if (!actor) {
      reply.status(404);
      return ACTOR_NOT_FOUND;
    }

    return { data: formatActor(actor) };
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
  }>(`/${segment}/:actorId`, async (request, reply) => {
    const { actorId } = request.params;
    const updates = UpdateActorSchema.parse(request.body);

    const current = await resolveActor(actorId, request.user!.id);
    if (!current) {
      reply.status(404);
      return ACTOR_NOT_FOUND;
    }

    if (updates.actorDefinition !== undefined) {
      // A defaultRunOptions in the body replaces the stored one wholesale,
      // so its image (or lack of one) is what counts.
      const image = imageOf(updates.defaultRunOptions ?? current.default_run_options);
      if (!image) {
        reply.status(400);
        return DEFINITION_REQUIRES_IMAGE;
      }
    }

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

    values.push(current.id);
    const actorIdParam = paramIndex++;
    values.push(request.user!.id);
    const userIdParam = paramIndex++;

    const result = await query<ActorRow>(
      `
      UPDATE actors SET ${setClauses.join(', ')}
      WHERE id = $${actorIdParam} AND user_id = $${userIdParam}
      RETURNING *
    `,
      values
    );

    // Deleted between the lookup and the update.
    if (!result.rows[0]) {
      reply.status(404);
      return ACTOR_NOT_FOUND;
    }

    if (
      updates.defaultRunOptions !== undefined ||
      updates.version !== undefined ||
      updates.actorDefinition !== undefined
    ) {
      await recordBuildIfNew(
        result.rows[0].id,
        updates.defaultRunOptions ?? result.rows[0].default_run_options,
        updates.version,
        (m) => fastify.log.warn(m),
        updates.actorDefinition
      );
    }

    return { data: formatActor({ ...result.rows[0], username: current.username }) };
  });

  /**
   * DELETE /v2/acts/:actorId - Delete actor (user-scoped)
   */
  fastify.delete<{
    Params: { actorId: string };
  }>(`/${segment}/:actorId`, async (request, reply) => {
    const { actorId } = request.params;
    const { force } = DeleteActorQuerySchema.parse(request.query);

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Resolve actor to concrete ID once at the top so sub-queries stay clean,
      // unknown actors 404 early, and operations have a stable key.
      const resolved = await resolveActor(actorId, request.user!.id, client);
      if (!resolved) {
        await client.query('ROLLBACK');
        reply.status(404);
        return ACTOR_NOT_FOUND;
      }
      const targetActorId = resolved.id;

      // Keep the default delete safe: callers must explicitly opt in before
      // removing the actor's execution history. The count is scoped by user so
      // a guessed actor id/name cannot reveal another tenant's runs.
      if (!force) {
        const runs = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM runs WHERE user_id = $2 AND actor_id = $1`,
          [targetActorId, request.user!.id]
        );
        if (Number(runs.rows[0]?.count ?? 0) > 0) {
          await client.query('ROLLBACK');
          reply.status(409);
          return {
            error: {
              type: 'actor-has-runs',
              message: 'Actor has runs. Set force=true to delete the actor and its runs.',
            },
          };
        }
      } else {
        // The schema deliberately keeps the default FK behaviour. Force delete
        // performs the cascade explicitly in the route, scoped to the actor and
        // tenant, so existing installations do not need a destructive migration.
        const activeRuns = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM runs
           WHERE user_id = $2 AND actor_id = $1 AND status IN ('READY', 'RUNNING', 'ABORTING')`,
          [targetActorId, request.user!.id]
        );
        if (Number(activeRuns.rows[0]?.count ?? 0) > 0) {
          await client.query('ROLLBACK');
          reply.status(409);
          return {
            error: {
              type: 'actor-has-active-runs',
              message:
                'Actor has active runs. Abort them and wait for termination before force deleting.',
            },
          };
        }
        // Delete runs and their deliveries in one statement so the cleanup
        // targets exactly the deleted rows — a subquery evaluated in a
        // separate statement could miss runs that turn terminal in between,
        // orphaning their deliveries (webhook_deliveries.run_id has no FK to
        // runs). The CTE keeps the id set server-side regardless of how large
        // the run history is.
        await client.query(
          `WITH deleted_runs AS (
             DELETE FROM runs
             WHERE user_id = $2 AND actor_id = $1 AND status NOT IN ('READY', 'RUNNING', 'ABORTING')
             RETURNING id
           )
           DELETE FROM webhook_deliveries wd
           USING deleted_runs d
           WHERE wd.run_id = d.id`,
          [targetActorId, request.user!.id]
        );
        const remainingRuns = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM runs WHERE user_id = $2 AND actor_id = $1`,
          [targetActorId, request.user!.id]
        );
        if (Number(remainingRuns.rows[0]?.count ?? 0) > 0) {
          await client.query('ROLLBACK');
          reply.status(409);
          return {
            error: {
              type: 'actor-has-active-runs',
              message:
                'Actor has active runs. Abort them and wait for termination before force deleting.',
            },
          };
        }
      }

      await client.query(`DELETE FROM actors WHERE id = $1 AND user_id = $2`, [
        targetActorId,
        request.user!.id,
      ]);
      await client.query('COMMIT');
      reply.status(204);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors if transaction was already aborted or connection closed
      }
      if ((err as { code?: string }).code === '23503') {
        reply.status(409);
        return {
          error: {
            type: 'actor-has-runs',
            message: force
              ? 'A run was created while the actor was being deleted. Retry the force deletion.'
              : 'Actor has runs. Set force=true to delete the actor and its runs.',
          },
        };
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * GET /v2/acts/:actorId/runs - List one actor's runs (user-scoped).
   *
   * Same query params, response shape and ordering as GET /v2/actor-runs —
   * both go through `listRuns`. The actor is resolved by ID or name with the
   * same user-scoped resolveActor lookup as GET /acts/:actorId, and runs are filtered by
   * the resolved `actors.id` (the path param may be a name).
   */
  fastify.get<{ Params: { actorId: string } }>(
    `/${segment}/:actorId/runs`,
    async (request, reply) => {
      const { actorId } = request.params;
      const q = ListRunsQuerySchema.parse(request.query);

      const actor = await resolveActor(actorId, request.user!.id);

      if (!actor) {
        reply.status(404);
        return ACTOR_NOT_FOUND;
      }

      return { data: await listRuns(request.user!.id, { ...q, actorId: actor.id }) };
    }
  );

  /**
   * POST /v2/acts/:actorId/runs - Start actor run
   *
   * Apify contract: the body is the actor input and run options come from
   * the query string (`timeout`, `memory`, `waitForFinish`, base64
   * `webhooks` / `envVars`). The legacy wrapper body `{ input, timeout,
   * memory, envVars, webhooks }` is still accepted until 1.0 — see
   * lib/run-body.ts. `waitForFinish=N` (clamped to 60) holds the response
   * until the new run is terminal or N seconds pass, like GET
   * /actor-runs/:runId, and then returns the full run object.
   */
  fastify.post<{
    Params: { actorId: string };
    Body: unknown;
  }>(`/${segment}/:actorId/runs`, async (request, reply) => {
    const { actorId } = request.params;
    if (isUnsupportedRunContentType(request.headers['content-type'])) {
      reply.status(415);
      return {
        error: {
          type: 'unsupported-media-type',
          message: 'Run input must be sent as application/json',
        },
      };
    }
    const parsed = parseRunStartRequest(request.body, request.query);
    const { input, envVars, webhooks } = parsed;
    if (parsed.legacy) {
      request.log.info({ actorId }, 'run-body: legacy');
    }

    // Get actor by ID, name or username~name, scoped to user. We need the actor's
    // default_run_options before we can resolve the run's timeout/memory.
    // Kept in the `{ rows }` shape the rest of this handler reads.
    const resolved = await resolveActor(actorId, request.user!.id);
    const actor = { rows: resolved ? [resolved] : [] };

    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Actor not found' } };
    }

    // Resolution order for timeout/memory: request override (query string,
    // or the legacy wrapper body) → actor's
    // default_run_options (set via `crc push` or PUT /v2/acts/:id) → the
    // platform fallback (3600s / 1024 MB). Previously the handler ignored
    // the actor's defaults and always fell back to 3600/1024 when the
    // request body omitted them, so actors configured with e.g.
    // timeoutSecs=7200 were silently killed at 3600s.
    const actorDefaults = (actor.rows[0].default_run_options ?? null) as {
      timeoutSecs?: number;
      memoryMbytes?: number;
    } | null;
    const timeout = parsed.timeout ?? actorDefaults?.timeoutSecs ?? 3600;
    const memory = parsed.memory ?? actorDefaults?.memoryMbytes ?? 1024;

    // Create default storages for this run
    const datasetId = nanoid();
    const kvStoreId = nanoid();
    const requestQueueId = nanoid();
    const runId = nanoid();

    // Create storages with user ownership.
    // KEEP-IN-SYNC: the rerun endpoint (routes/runs.ts POST
    // /actor-runs/:runId/rerun) clones this creation flow — storage trio,
    // INPUT write, build stamp. Update both together. (Rerun copies the
    // origin's stored INPUT record as-is, so the body/query parsing in
    // lib/run-body.ts has no rerun counterpart.)
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

    // Always store input in the KV store (parseRunStartRequest turns a
    // missing input into an empty object)
    const { putKVRecord } = await import('../storage/s3.js');
    await putKVRecord(kvStoreId, 'INPUT', JSON.stringify(input), 'application/json');

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

    if (parsed.waitForFinish > 0) {
      markLongPoll(request);
      const abort = waitAbortSignal(reply);
      try {
        const run = await waitForTerminal({
          load: () => loadRun(runId, request.user!.id),
          isTerminal: (r) => isTerminalStatus(r.status),
          waitSecs: parsed.waitForFinish,
          signal: abort.signal,
        });
        // Only null if the run was deleted mid-wait; fall through to the
        // creation response below.
        if (run) return { data: formatRun(run) };
      } finally {
        abort.dispose();
      }
    }

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
    Body: unknown;
  }>(`/${segment}/:actorId/run-sync`, async (request, reply) => {
    // For now, just create the run - it does not wait for the run to finish.
    // Forwards body, query string (run options, `?token=`), Authorization
    // and Content-Type so the start route sees the request as sent.
    // Always targets /acts, which stays registered alongside the /actors alias.
    const queryIndex = request.url.indexOf('?');
    const search = queryIndex === -1 ? '' : request.url.slice(queryIndex);
    const headers: Record<string, string> = {};
    if (request.headers.authorization) headers.authorization = request.headers.authorization;
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];

    // Re-serialize the parsed body: injecting a parsed JSON string or number
    // would send it raw. Buffers (text/plain, octet-stream) go through as-is
    // and the start route answers them with 415.
    let payload: string | Buffer | undefined;
    if (Buffer.isBuffer(request.body)) payload = request.body;
    else if (request.body !== undefined) payload = JSON.stringify(request.body);

    const res = await fastify.inject({
      method: 'POST',
      url: `/v2/acts/${encodeURIComponent(request.params.actorId)}/runs${search}`,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    reply.status(res.statusCode);
    const contentType = res.headers['content-type'];
    if (contentType) reply.header('content-type', contentType);
    return reply.send(res.payload);
  });
};

function formatActor(row: ActorRowWithUsername) {
  return {
    id: row.id,
    name: row.name,
    // apify-client / the Apify MCP server address actors as `username/name`.
    username: row.username,
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
