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
 * GET /v2/acts/:actorId/builds/:buildId - Get build
 * POST /v2/acts/:actorId/builds/:buildId/abort - Abort build
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';
import { redis } from '../storage/redis.js';

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

interface BuildRow {
  id: string;
  actor_id: string;
  version_id: string | null;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  image_name: string | null;
  image_digest: string | null;
  image_size_bytes: number | null;
  log_count: number;
  git_branch: string | null;
  git_commit: string | null;
  created_at: Date;
}

export const registryRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes require authentication
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/acts/:actorId/versions - List all versions
   */
  fastify.get<{ Params: { actorId: string } }>(
    '/acts/:actorId/versions',
    async (request) => {
      const { actorId } = request.params;
      
      const result = await query<VersionRow>(
        `SELECT * FROM actor_versions WHERE actor_id = $1 ORDER BY created_at DESC`,
        [actorId]
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
  }>('/acts/:actorId/versions', async (request, reply) => {
    const { actorId } = request.params;
    const { versionNumber, sourceType, sourceUrl, dockerfile, buildTag, envVars } = request.body;
    
    // Check actor exists
    const actor = await query('SELECT id FROM actors WHERE id = $1', [actorId]);
    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { message: 'Actor not found' } };
    }
    
    const id = nanoid();
    const result = await query<VersionRow>(
      `INSERT INTO actor_versions 
       (id, actor_id, version_number, source_type, source_url, dockerfile, build_tag, env_vars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, actorId, versionNumber, sourceType || 'GIT_REPO', sourceUrl, dockerfile, buildTag, envVars ? JSON.stringify(envVars) : null]
    );
    
    reply.status(201);
    return { data: formatVersion(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId/versions/:versionId - Get version details
   */
  fastify.get<{ Params: { actorId: string; versionId: string } }>(
    '/acts/:actorId/versions/:versionId',
    async (request, reply) => {
      const { actorId, versionId } = request.params;
      
      const result = await query<VersionRow>(
        `SELECT * FROM actor_versions WHERE id = $1 AND actor_id = $2`,
        [versionId, actorId]
      );
      
      if (!result.rows[0]) {
        reply.status(404);
        return { error: { message: 'Version not found' } };
      }
      
      return { data: formatVersion(result.rows[0]) };
    }
  );

  /**
   * DELETE /v2/acts/:actorId/versions/:versionId - Delete version
   */
  fastify.delete<{ Params: { actorId: string; versionId: string } }>(
    '/acts/:actorId/versions/:versionId',
    async (request, reply) => {
      const { actorId, versionId } = request.params;
      
      await query(
        `DELETE FROM actor_versions WHERE id = $1 AND actor_id = $2`,
        [versionId, actorId]
      );
      
      reply.status(204);
    }
  );

  /**
   * GET /v2/acts/:actorId/builds - List all builds
   */
  fastify.get<{ Params: { actorId: string } }>(
    '/acts/:actorId/builds',
    async (request) => {
      const { actorId } = request.params;
      
      const result = await query<BuildRow>(
        `SELECT * FROM actor_builds WHERE actor_id = $1 ORDER BY created_at DESC`,
        [actorId]
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
  }>('/acts/:actorId/builds', async (request, reply) => {
    const { actorId } = request.params;
    const { versionId, gitBranch, gitCommit } = request.body;
    
    // Check actor exists
    const actor = await query('SELECT id, name FROM actors WHERE id = $1', [actorId]);
    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { message: 'Actor not found' } };
    }
    
    const id = nanoid();
    const imageName = `crawlee-cloud/${actor.rows[0].name}:${id.slice(0, 8)}`;
    
    const result = await query<BuildRow>(
      `INSERT INTO actor_builds 
       (id, actor_id, version_id, status, image_name, git_branch, git_commit, started_at)
       VALUES ($1, $2, $3, 'RUNNING', $4, $5, $6, NOW())
       RETURNING *`,
      [id, actorId, versionId, imageName, gitBranch, gitCommit]
    );
    
    // Queue build job in Redis
    await redis.rpush('build_queue', JSON.stringify({
      buildId: id,
      actorId,
      versionId,
      imageName,
      gitBranch,
      gitCommit,
    }));
    
    reply.status(201);
    return { data: formatBuild(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId/builds/:buildId - Get build details
   */
  fastify.get<{ Params: { actorId: string; buildId: string } }>(
    '/acts/:actorId/builds/:buildId',
    async (request, reply) => {
      const { actorId, buildId } = request.params;
      
      const result = await query<BuildRow>(
        `SELECT * FROM actor_builds WHERE id = $1 AND actor_id = $2`,
        [buildId, actorId]
      );
      
      if (!result.rows[0]) {
        reply.status(404);
        return { error: { message: 'Build not found' } };
      }
      
      return { data: formatBuild(result.rows[0]) };
    }
  );

  /**
   * POST /v2/acts/:actorId/builds/:buildId/abort - Abort a running build
   */
  fastify.post<{ Params: { actorId: string; buildId: string } }>(
    '/acts/:actorId/builds/:buildId/abort',
    async (request, reply) => {
      const { actorId, buildId } = request.params;
      
      const result = await query<BuildRow>(
        `UPDATE actor_builds 
         SET status = 'ABORTED', finished_at = NOW()
         WHERE id = $1 AND actor_id = $2 AND status = 'RUNNING'
         RETURNING *`,
        [buildId, actorId]
      );
      
      if (!result.rows[0]) {
        reply.status(404);
        return { error: { message: 'Build not found or not running' } };
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
  }>('/acts/:actorId/builds/:buildId/logs', async (request) => {
    const { buildId } = request.params;
    const offset = parseInt(request.query.offset || '0', 10);
    const limit = parseInt(request.query.limit || '100', 10);
    
    const logs = await redis.lrange(`build_logs:${buildId}`, offset, offset + limit - 1);
    
    return {
      data: {
        offset,
        limit,
        count: logs.length,
        items: logs.map(l => JSON.parse(l)),
      },
    };
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

function formatBuild(row: BuildRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    versionId: row.version_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    imageName: row.image_name,
    imageDigest: row.image_digest,
    imageSizeBytes: row.image_size_bytes,
    logCount: row.log_count,
    gitBranch: row.git_branch,
    gitCommit: row.git_commit,
    createdAt: row.created_at,
  };
}
