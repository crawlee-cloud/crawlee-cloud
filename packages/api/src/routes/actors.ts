/**
 * Actor routes - Apify-compatible endpoints for managing Actors.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { redis } from '../storage/redis.js';

interface ActorRow {
  id: string;
  name: string;
  user_id: string | null;
  title: string | null;
  description: string | null;
  default_run_options: Record<string, unknown> | null;
  created_at: Date;
  modified_at: Date;
}

export const actorsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v2/acts - List actors
   */
  fastify.get('/acts', async () => {
    const result = await query<ActorRow>('SELECT * FROM actors ORDER BY created_at DESC LIMIT 100');
    
    return {
      data: {
        total: result.rows.length,
        count: result.rows.length,
        offset: 0,
        limit: 100,
        items: result.rows.map(formatActor),
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
    };
  }>('/acts', async (request, reply) => {
    const { name, title, description, defaultRunOptions } = request.body;
    
    // Check if actor with this name already exists
    const existing = await query<ActorRow>('SELECT * FROM actors WHERE name = $1', [name]);
    
    if (existing.rows[0]) {
      // Update existing actor
      const result = await query<ActorRow>(`
        UPDATE actors 
        SET title = $1, description = $2, default_run_options = $3, modified_at = NOW()
        WHERE name = $4
        RETURNING *
      `, [
        title ?? existing.rows[0].title,
        description ?? existing.rows[0].description,
        defaultRunOptions ? JSON.stringify(defaultRunOptions) : existing.rows[0].default_run_options,
        name
      ]);
      
      return { data: formatActor(result.rows[0]!) };
    }
    
    // Create new actor
    const id = nanoid();
    const result = await query<ActorRow>(`
      INSERT INTO actors (id, name, title, description, default_run_options)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [id, name, title ?? null, description ?? null, defaultRunOptions ? JSON.stringify(defaultRunOptions) : null]);
    
    reply.status(201);
    return { data: formatActor(result.rows[0]!) };
  });

  /**
   * GET /v2/acts/:actorId - Get actor
   */
  fastify.get<{ Params: { actorId: string } }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;
    
    // Get actor by ID or name
    const result = await query<ActorRow>(
      `SELECT * FROM actors WHERE id = $1 OR name = $1`,
      [actorId]
    );
    
    if (!result.rows[0]) {
      reply.status(404);
      return { error: { message: 'Actor not found' } };
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
    };
  }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;
    const updates = request.body;
    
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
    
    values.push(actorId);
    
    const result = await query<ActorRow>(`
      UPDATE actors SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex} OR name = $${paramIndex}
      RETURNING *
    `, [...values, actorId]);
    
    if (!result.rows[0]) {
      reply.status(404);
      return { error: { message: 'Actor not found' } };
    }
    
    return { data: formatActor(result.rows[0]) };
  });

  /**
   * DELETE /v2/acts/:actorId - Delete actor
   */
  fastify.delete<{ Params: { actorId: string } }>('/acts/:actorId', async (request, reply) => {
    const { actorId } = request.params;
    await query(`DELETE FROM actors WHERE id = $1 OR name = $1`, [actorId]);
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
    };
  }>('/acts/:actorId/runs', async (request, reply) => {
    const { actorId } = request.params;
    const { input, timeout = 3600, memory = 1024 } = request.body || {};
    
    // Get actor by ID or name
    const actor = await query<ActorRow>(
      `SELECT * FROM actors WHERE id = $1 OR name = $1`,
      [actorId]
    );
    
    if (!actor.rows[0]) {
      reply.status(404);
      return { error: { message: 'Actor not found' } };
    }
    
    // Create default storages for this run
    const datasetId = nanoid();
    const kvStoreId = nanoid();
    const requestQueueId = nanoid();
    const runId = nanoid();
    
    await query('INSERT INTO datasets (id) VALUES ($1)', [datasetId]);
    await query('INSERT INTO key_value_stores (id) VALUES ($1)', [kvStoreId]);
    await query('INSERT INTO request_queues (id) VALUES ($1)', [requestQueueId]);
    
    // Always store input in the KV store (empty object if not provided)
    const { putKVRecord } = await import('../storage/s3.js');
    await putKVRecord(kvStoreId, 'INPUT', JSON.stringify(input ?? {}), 'application/json');
    
    // Create run record with READY status so Runner picks it up
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
    }>(`
      INSERT INTO runs (id, actor_id, status, default_dataset_id, default_key_value_store_id, default_request_queue_id, timeout_secs, memory_mbytes)
      VALUES ($1, $2, 'READY', $3, $4, $5, $6, $7)
      RETURNING *
    `, [runId, actor.rows[0].id, datasetId, kvStoreId, requestQueueId, timeout, memory]);
    
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
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
