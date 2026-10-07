/**
 * Actor Registry routes for version and build management.
 *
 * GET /v2/acts/:actorId/versions - List versions
 * POST /v2/acts/:actorId/versions - Create version
 * GET /v2/acts/:actorId/versions/:versionId - Get version
 * DELETE /v2/acts/:actorId/versions/:versionId - Delete version
 *
 * GET /v2/acts/:actorId/builds - List builds
 * POST /v2/acts/:actorId/builds - Start build
 * GET /v2/acts/:actorId/builds/default - Get the default build (#117)
 * GET /v2/acts/:actorId/builds/:buildId - Get build
 * POST /v2/acts/:actorId/builds/:buildId/abort - Abort build
 * GET /v2/acts/:actorId/builds/:buildId/logs - Get build logs
 *
 * Every route is also served under /v2/actors/... (see ActorsSegmentOptions).
 *
 * GET /v2/actor-builds/:buildId - Get build by ID (actorBuildsRoutes, #117)
 *
 * Every route resolves `:actorId` (ID, name or username~name) to one of the
 * caller's own actors first and 404s otherwise, so another user's versions
 * and builds can't be read, deleted, started or aborted (#77). Build routes
 * additionally require the build to belong to the resolved actor.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ActorsSegmentOptions } from './actors.js';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';
import { redis } from '../storage/redis.js';
import { resolveActor, ACTOR_NOT_FOUND, type ResolvedActor } from '../lib/resolve-actor.js';
import {
  BUILD_COLUMNS,
  BUILD_COLUMNS_B,
  BUILD_NUMBER_WINDOW_SQL,
  buildSelectSql,
  formatBuild,
  loadBuild,
  selectDefaultBuild,
  type BuildRow,
} from '../lib/builds.js';
import {
  waitForTerminal,
  parseWaitForFinish,
  createWaitAbortFactory,
  isTerminalStatus,
  markLongPoll,
  type WaitAbortHandle,
} from '../lib/wait-for-terminal.js';

interface VersionRow {
  id: string;
  actor_id: string;
  version_number: string;
  source_type: string;
  source_url: string | null;
  dockerfile: string | null;
  build_tag: string | null;
  env_vars: Record<string, string> | null;
  is_deprecated: boolean;
  created_at: Date;
}

/**
 * Resolve the route's `:actorId` to one of the caller's actors. On a miss
 * the 404 is already set on `reply` and the caller returns ACTOR_NOT_FOUND.
 */
async function ownedActor(
  request: FastifyRequest<{ Params: { actorId: string } }>,
  reply: FastifyReply
): Promise<ResolvedActor | null> {
  const actor = await resolveActor(request.params.actorId, request.user!.id);
  if (!actor) reply.status(404);
  return actor;
}

const BUILD_NOT_FOUND = {
  error: { type: 'record-not-found', message: 'Build not found' },
} as const;

/**
 * Load a build, long-polling while it is non-terminal when the request has
 * `waitForFinish=N` (same semantics as GET /actor-runs/:runId, #111). A
 * missing build (null) ends the wait immediately.
 */
async function loadBuildWithWait(
  request: FastifyRequest,
  reply: FastifyReply,
  waitAbortSignal: (reply: FastifyReply) => WaitAbortHandle,
  waitSecs: number,
  load: () => Promise<BuildRow | null>
): Promise<BuildRow | null> {
  if (waitSecs <= 0) return load();

  markLongPoll(request);
  const abort = waitAbortSignal(reply);
  try {
    return await waitForTerminal({
      load,
      isTerminal: (b) => isTerminalStatus(b.status),
      waitSecs,
      signal: abort.signal,
    });
  } finally {
    abort.dispose();
  }
}

export const registryRoutes: FastifyPluginAsync<ActorsSegmentOptions> = async (
  fastify,
  opts = {}
) => {
  const segment = opts.actorsSegment ?? 'acts';
  // All routes require authentication
  fastify.addHook('preHandler', authenticate);
  const waitAbortSignal = createWaitAbortFactory(fastify);

  /**
   * GET /v2/acts/:actorId/versions - List all versions
   */
  fastify.get<{ Params: { actorId: string } }>(
    `/${segment}/:actorId/versions`,
    async (request, reply) => {
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      const result = await query<VersionRow>(
        `SELECT * FROM actor_versions WHERE actor_id = $1 ORDER BY created_at DESC`,
        [actor.id]
      );

      return {
        data: {
          total: result.rows.length,
          items: result.rows.map(formatVersion),
        },
      };
    }
  );

  /**
   * POST /v2/acts/:actorId/versions - Create new version
   */
  fastify.post<{
    Params: { actorId: string };
    Body: {
      versionNumber: string;
      sourceType?: string;
      sourceUrl?: string;
      dockerfile?: string;
      buildTag?: string;
      envVars?: Record<string, string>;
    };
  }>(`/${segment}/:actorId/versions`, async (request, reply) => {
    const { versionNumber, sourceType, sourceUrl, dockerfile, buildTag, envVars } = request.body;

    const actor = await ownedActor(request, reply);
    if (!actor) return ACTOR_NOT_FOUND;

    // The build_tag column has a partial UNIQUE index per actor (see
    // db/migrate.ts: idx_actor_versions_actor_tag). To avoid a constraint
    // violation when the caller wants the new version to claim a tag that
    // an existing version still holds, we clear siblings in the same
    // statement. This mirrors the behaviour of findOrCreateActorVersion in
    // routes/actors.ts so both insertion paths converge on the same
    // "single-pointer-per-tag" invariant.
    const id = nanoid();
    const result = await query<VersionRow>(
      `WITH cleared AS (
         UPDATE actor_versions SET build_tag = NULL
         WHERE actor_id = $2 AND build_tag IS NOT NULL AND build_tag = $7 AND version_number <> $3
       )
       INSERT INTO actor_versions
         (id, actor_id, version_number, source_type, source_url, dockerfile, build_tag, env_vars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        actor.id,
        versionNumber,
        sourceType || 'GIT_REPO',
        sourceUrl,
        dockerfile,
        buildTag,
        envVars ? JSON.stringify(envVars) : null,
      ]
    );

    reply.status(201);
    return { data: formatVersion(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId/versions/:versionId - Get version details
   */
  fastify.get<{ Params: { actorId: string; versionId: string } }>(
    `/${segment}/:actorId/versions/:versionId`,
    async (request, reply) => {
      const { versionId } = request.params;
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      const result = await query<VersionRow>(
        `SELECT * FROM actor_versions WHERE id = $1 AND actor_id = $2`,
        [versionId, actor.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Version not found' } };
      }

      return { data: formatVersion(result.rows[0]) };
    }
  );

  /**
   * DELETE /v2/acts/:actorId/versions/:versionId - Delete version
   */
  fastify.delete<{ Params: { actorId: string; versionId: string } }>(
    `/${segment}/:actorId/versions/:versionId`,
    async (request, reply) => {
      const { versionId } = request.params;
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      await query(`DELETE FROM actor_versions WHERE id = $1 AND actor_id = $2`, [
        versionId,
        actor.id,
      ]);

      reply.status(204);
    }
  );

  /**
   * GET /v2/acts/:actorId/builds - List all builds
   */
  fastify.get<{ Params: { actorId: string } }>(
    `/${segment}/:actorId/builds`,
    async (request, reply) => {
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      // LEFT JOIN actor_versions so the dashboard can show "0.1 (latest)"
      // alongside the image, without an N+1 lookup per row. LEFT JOIN (not
      // inner) to keep historical builds whose version_id may have been
      // SET NULL when a version was deleted.
      // buildNumber's window covers all of a version's builds, since every
      // build of a version belongs to that version's actor.
      const result = await query<BuildRow>(
        `SELECT ${BUILD_COLUMNS_B}, v.version_number, v.build_tag, a.user_id,
                ${BUILD_NUMBER_WINDOW_SQL} AS build_number
           FROM actor_builds b
           JOIN actors a ON a.id = b.actor_id
           LEFT JOIN actor_versions v ON v.id = b.version_id
          WHERE b.actor_id = $1
          ORDER BY b.created_at DESC`,
        [actor.id]
      );

      return {
        data: {
          total: result.rows.length,
          items: result.rows.map(formatBuild),
        },
      };
    }
  );

  /**
   * POST /v2/acts/:actorId/builds - Start a new build
   */
  fastify.post<{
    Params: { actorId: string };
    Body: {
      versionId?: string;
      gitBranch?: string;
      gitCommit?: string;
    };
  }>(`/${segment}/:actorId/builds`, async (request, reply) => {
    const { versionId, gitBranch, gitCommit } = request.body;

    const actor = await ownedActor(request, reply);
    if (!actor) return ACTOR_NOT_FOUND;
    const actorId = actor.id;

    const id = nanoid();
    const imageName = `crawlee-cloud/${actor.name}:${id.slice(0, 8)}`;

    const result = await query<BuildRow>(
      `WITH inserted AS (
         INSERT INTO actor_builds
         (id, actor_id, version_id, status, image_name, git_branch, git_commit, started_at)
         VALUES ($1, $2, $3, 'RUNNING', $4, $5, $6, NOW())
         RETURNING ${BUILD_COLUMNS}
       )
       ${buildSelectSql('inserted')}`,
      [id, actorId, versionId, imageName, gitBranch, gitCommit]
    );

    // Queue build job in Redis
    await redis.rpush(
      'build_queue',
      JSON.stringify({
        buildId: id,
        actorId,
        versionId,
        imageName,
        gitBranch,
        gitCommit,
      })
    );

    reply.status(201);
    return { data: formatBuild(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId/builds/default - Get the actor's default build
   *
   * apify-client `actor.defaultBuild()` calls this, then GET
   * /actor-builds/:id and reads `actorDefinition`. The choice (newest
   * SUCCEEDED build of the `latest` version, else of the actor; never a
   * RUNNING orphan) lives in selectDefaultBuild. The static `default`
   * segment wins over `:buildId` in find-my-way regardless of order.
   */
  fastify.get<{ Params: { actorId: string } }>(
    `/${segment}/:actorId/builds/default`,
    async (request, reply) => {
      const waitSecs = parseWaitForFinish(request.query);
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      const build = await loadBuildWithWait(request, reply, waitAbortSignal, waitSecs, () =>
        selectDefaultBuild(actor.id)
      );
      if (!build) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Default build not found' } };
      }

      return { data: formatBuild(build) };
    }
  );

  /**
   * GET /v2/acts/:actorId/builds/:buildId - Get build details
   */
  fastify.get<{ Params: { actorId: string; buildId: string } }>(
    `/${segment}/:actorId/builds/:buildId`,
    async (request, reply) => {
      const { buildId } = request.params;
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      const result = await query<BuildRow>(
        `${buildSelectSql()} WHERE b.id = $1 AND b.actor_id = $2`,
        [buildId, actor.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return BUILD_NOT_FOUND;
      }

      return { data: formatBuild(result.rows[0]) };
    }
  );

  /**
   * POST /v2/acts/:actorId/builds/:buildId/abort - Abort a running build
   */
  fastify.post<{ Params: { actorId: string; buildId: string } }>(
    `/${segment}/:actorId/builds/:buildId/abort`,
    async (request, reply) => {
      const { buildId } = request.params;
      const actor = await ownedActor(request, reply);
      if (!actor) return ACTOR_NOT_FOUND;

      const result = await query<BuildRow>(
        `WITH aborted AS (
           UPDATE actor_builds
           SET status = 'ABORTED', finished_at = NOW()
           WHERE id = $1 AND actor_id = $2 AND status = 'RUNNING'
           RETURNING ${BUILD_COLUMNS}
         )
         ${buildSelectSql('aborted')}`,
        [buildId, actor.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Build not found or not running' } };
      }

      return { data: formatBuild(result.rows[0]) };
    }
  );

  /**
   * GET /v2/acts/:actorId/builds/:buildId/logs - Get build logs
   */
  fastify.get<{
    Params: { actorId: string; buildId: string };
    Querystring: { offset?: string; limit?: string };
  }>(`/${segment}/:actorId/builds/:buildId/logs`, async (request, reply) => {
    const { buildId } = request.params;
    const actor = await ownedActor(request, reply);
    if (!actor) return ACTOR_NOT_FOUND;

    // Logs are keyed by build ID alone, so check the build is this actor's.
    const build = await query('SELECT 1 FROM actor_builds WHERE id = $1 AND actor_id = $2', [
      buildId,
      actor.id,
    ]);
    if (!build.rows[0]) {
      reply.status(404);
      return BUILD_NOT_FOUND;
    }

    const offset = parseInt(request.query.offset || '0', 10);
    const limit = parseInt(request.query.limit || '100', 10);

    const logs = await redis.lrange(`build_logs:${buildId}`, offset, offset + limit - 1);

    return {
      data: {
        offset,
        limit,
        count: logs.length,
        items: logs.map((l) => JSON.parse(l)),
      },
    };
  });
};

/**
 * GET /v2/actor-builds/:buildId - Get a build by ID (apify-client
 * `client.build(id)`, `resourcePath: 'actor-builds'`).
 *
 * A separate plugin, registered once: the path has no actor segment, so it
 * must not be part of registryRoutes, which registerV2Routes registers twice
 * (/acts and /actors) — that would be a duplicate-route error. Scoped to the
 * caller through actor_builds.actor_id → actors.user_id; another user's
 * build is a 404. `waitForFinish=N` long-polls like GET /actor-runs/:runId.
 */
export const actorBuildsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);
  const waitAbortSignal = createWaitAbortFactory(fastify);

  fastify.get<{ Params: { buildId: string } }>('/actor-builds/:buildId', async (request, reply) => {
    const { buildId } = request.params;
    const waitSecs = parseWaitForFinish(request.query);

    const build = await loadBuildWithWait(request, reply, waitAbortSignal, waitSecs, () =>
      loadBuild(buildId, request.user!.id)
    );
    if (!build) {
      reply.status(404);
      return BUILD_NOT_FOUND;
    }

    return { data: formatBuild(build) };
  });
};

function formatVersion(row: VersionRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    versionNumber: row.version_number,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    dockerfile: row.dockerfile,
    buildTag: row.build_tag,
    envVars: row.env_vars,
    isDeprecated: row.is_deprecated,
    createdAt: row.created_at,
  };
}
