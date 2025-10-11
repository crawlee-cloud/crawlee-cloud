/**
 * Key-Value Store routes - Apify-compatible endpoints.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { putKVRecord, getKVRecord, deleteKVRecord, listKVKeys, kvRecordExists } from '../storage/s3.js';

interface KVStoreRow {
  id: string;
  name: string | null;
  user_id: string | null;
  created_at: Date;
  modified_at: Date;
  accessed_at: Date;
}

export const keyValueStoresRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v2/key-value-stores - List stores
   */
  fastify.get('/key-value-stores', async () => {
    const result = await query<KVStoreRow>('SELECT * FROM key_value_stores ORDER BY created_at DESC LIMIT 100');
    
    return {
      data: {
        total: result.rows.length,
        count: result.rows.length,
        offset: 0,
        limit: 100,
        items: result.rows.map(formatStore),
      },
    };
  });

  /**
   * POST /v2/key-value-stores - Create or get store
   */
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>('/key-value-stores', async (request, reply) => {
    const name = request.query.name || request.body?.name;
    
    if (name) {
      const existing = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE name = $1',
        [name]
      );
      if (existing.rows[0]) {
        return { data: formatStore(existing.rows[0]) };
      }
    }
    
    const id = nanoid();
    const result = await query<KVStoreRow>(
      `INSERT INTO key_value_stores (id, name) VALUES ($1, $2) RETURNING *`,
      [id, name || null]
    );
    
    reply.status(201);
    return { data: formatStore(result.rows[0]!) };
  });

  /**
   * GET /v2/key-value-stores/:storeId - Get store info
   */
  fastify.get<{ Params: { storeId: string } }>('/key-value-stores/:storeId', async (request, reply) => {
    const { storeId } = request.params;
    
    const result = await query<KVStoreRow>(
      'SELECT * FROM key_value_stores WHERE id = $1 OR name = $2',
      [storeId, storeId]
    );
    
    if (!result.rows[0]) {
      reply.status(404);
      return { error: { message: 'Key-value store not found' } };
    }
    
    await query('UPDATE key_value_stores SET accessed_at = NOW() WHERE id = $1', [result.rows[0].id]);
    
    return { data: formatStore(result.rows[0]) };
  });

  /**
   * DELETE /v2/key-value-stores/:storeId - Delete store
   */
  fastify.delete<{ Params: { storeId: string } }>('/key-value-stores/:storeId', async (request, reply) => {
    const { storeId } = request.params;
    await query('DELETE FROM key_value_stores WHERE id = $1 OR name = $2', [storeId, storeId]);
    reply.status(204);
  });

  /**
   * GET /v2/key-value-stores/:storeId/keys - List keys
   */
  fastify.get<{
    Params: { storeId: string };
    Querystring: { limit?: string; exclusiveStartKey?: string };
  }>('/key-value-stores/:storeId/keys', async (request, reply) => {
    const { storeId } = request.params;
    const limit = parseInt(request.query.limit || '100', 10);
    const { exclusiveStartKey } = request.query;
    
    const store = await query<KVStoreRow>(
      'SELECT * FROM key_value_stores WHERE id = $1 OR name = $2',
      [storeId, storeId]
    );
    
    if (!store.rows[0]) {
      reply.status(404);
      return { error: { message: 'Key-value store not found' } };
    }
    
    const result = await listKVKeys(store.rows[0].id, { limit, exclusiveStartKey });
    
    return {
      data: {
        count: result.keys.length,
        limit,
        isTruncated: result.isTruncated,
        nextExclusiveStartKey: result.nextExclusiveStartKey,
        items: result.keys,
      },
    };
  });

  /**
   * GET /v2/key-value-stores/:storeId/records/:key - Get record
   * 
   * This is used for Actor.getInput(), Actor.getValue(), etc.
   */
  fastify.get<{ Params: { storeId: string; key: string } }>(
    '/key-value-stores/:storeId/records/:key',
    async (request, reply) => {
      const { storeId, key } = request.params;
      
      // Get or auto-create store
      let store = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE id = $1 OR name = $2',
        [storeId, storeId]
      );
      
      if (!store.rows[0]) {
        reply.status(404);
        return { error: { message: 'Key-value store not found' } };
      }
      
      const record = await getKVRecord(store.rows[0].id, key);
      
      if (!record) {
        // Return 204 No Content for missing records (Apify SDK compatibility)
        reply.status(204);
        return;
      }
      
      reply.header('content-type', record.contentType);
      return reply.send(record.value);
    }
  );

  /**
   * PUT /v2/key-value-stores/:storeId/records/:key - Set record
   * 
   * This is used for Actor.setValue()
   */
  fastify.put<{ Params: { storeId: string; key: string } }>(
    '/key-value-stores/:storeId/records/:key',
    async (request, reply) => {
      const { storeId, key } = request.params;
      const contentType = request.headers['content-type'] ?? 'application/json';
      
      // Get or auto-create store
      let store = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE id = $1 OR name = $2',
        [storeId, storeId]
      );
      
      if (!store.rows[0]) {
        // Auto-create
        const id = storeId === 'default' ? nanoid() : storeId;
        await query(
          `INSERT INTO key_value_stores (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, storeId === 'default' ? null : storeId]
        );
        store = await query<KVStoreRow>('SELECT * FROM key_value_stores WHERE id = $1', [id]);
      }
      
      const body = request.body;
      // Handle different body types (string, Buffer, object)
      let data: string;
      if (Buffer.isBuffer(body)) {
        data = body.toString('utf-8');
      } else if (typeof body === 'string') {
        data = body;
      } else {
        data = JSON.stringify(body);
      }
      
      await putKVRecord(store.rows[0]!.id, key, data, contentType);
      
      await query('UPDATE key_value_stores SET modified_at = NOW() WHERE id = $1', [store.rows[0]!.id]);
      
      reply.status(201);
      return {};
    }
  );

  /**
   * DELETE /v2/key-value-stores/:storeId/records/:key - Delete record
   */
  fastify.delete<{ Params: { storeId: string; key: string } }>(
    '/key-value-stores/:storeId/records/:key',
    async (request, reply) => {
      const { storeId, key } = request.params;
      
      const store = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE id = $1 OR name = $2',
        [storeId, storeId]
      );
      
      if (!store.rows[0]) {
        reply.status(404);
        return { error: { message: 'Key-value store not found' } };
      }
      
      await deleteKVRecord(store.rows[0].id, key);
      reply.status(204);
    }
  );
};

function formatStore(row: KVStoreRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    accessedAt: row.accessed_at,
  };
}
