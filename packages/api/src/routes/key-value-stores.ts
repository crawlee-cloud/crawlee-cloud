/**
 * Key-Value Store routes - Apify-compatible endpoints.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import {
  putKVRecord,
  getKVRecord,
  deleteKVRecord,
  listKVKeys,
  presignKVRecord,
} from '../storage/s3.js';
import { authenticate } from '../auth/middleware.js';
import { CreateKeyValueStoreSchema } from '../schemas/key-value-stores.js';

interface KVStoreRow {
  id: string;
  name: string | null;
  user_id: string | null;
  created_at: Date;
  modified_at: Date;
  accessed_at: Date;
}

export const keyValueStoresRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/key-value-stores - List stores (user-scoped)
   */
  fastify.get<{
    Querystring: { offset?: string; limit?: string };
  }>('/key-value-stores', async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM key_value_stores WHERE user_id = $1',
        [request.user!.id]
      ),
      query<KVStoreRow>(
        `SELECT * FROM key_value_stores WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [request.user!.id, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    return {
      data: {
        total,
        count: pageResult.rows.length,
        offset,
        limit,
        items: pageResult.rows.map(formatStore),
      },
    };
  });

  /**
   * POST /v2/key-value-stores - Create or get store
   */
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>(
    '/key-value-stores',
    async (request, reply) => {
      const body = CreateKeyValueStoreSchema.parse(request.body || {});
      const name = request.query.name || body.name;

      if (name) {
        const existing = await query<KVStoreRow>(
          'SELECT * FROM key_value_stores WHERE name = $1 AND user_id = $2',
          [name, request.user!.id]
        );
        if (existing.rows[0]) {
          return { data: formatStore(existing.rows[0]) };
        }
      }

      const id = nanoid();
      const result = await query<KVStoreRow>(
        `INSERT INTO key_value_stores (id, name, user_id) VALUES ($1, $2, $3) RETURNING *`,
        [id, name || null, request.user!.id]
      );

      reply.status(201);
      return { data: formatStore(result.rows[0]!) };
    }
  );

  /**
   * GET /v2/key-value-stores/:storeId - Get store info (user-scoped)
   */
  fastify.get<{ Params: { storeId: string } }>(
    '/key-value-stores/:storeId',
    async (request, reply) => {
      const { storeId } = request.params;

      const result = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3',
        [storeId, storeId, request.user!.id]
      );

      if (!result.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
      }

      await query('UPDATE key_value_stores SET accessed_at = NOW() WHERE id = $1', [
        result.rows[0].id,
      ]);

      return { data: formatStore(result.rows[0]) };
    }
  );

  /**
   * DELETE /v2/key-value-stores/:storeId - Delete store (user-scoped)
   */
  fastify.delete<{ Params: { storeId: string } }>(
    '/key-value-stores/:storeId',
    async (request, reply) => {
      const { storeId } = request.params;
      const result = await query(
        'DELETE FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3 RETURNING id',
        [storeId, storeId, request.user!.id]
      );
      if (result.rowCount === 0) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
      }
      reply.status(204);
    }
  );

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
      'SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3',
      [storeId, storeId, request.user!.id]
    );

    if (!store.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
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
  fastify.get<{
    Params: { storeId: string; key: string };
    Querystring: { presigned?: string };
  }>('/key-value-stores/:storeId/records/:key', async (request, reply) => {
    const { storeId, key } = request.params;

    // Get store (user-scoped)
    const store = await query<KVStoreRow>(
      'SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3',
      [storeId, storeId, request.user!.id]
    );

    if (!store.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
    }

    // ?presigned=1 — return a 1-hour S3 URL the browser can open directly.
    // Sidesteps the API server entirely for large payloads (binary
    // screenshots, megabyte-sized JSON, etc.) and matches Apify's UX:
    // dashboard renders nothing huge, "View raw" opens a static file.
    if (request.query.presigned === '1' || request.query.presigned === 'true') {
      const presigned = await presignKVRecord(store.rows[0].id, key);
      if (!presigned) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Record not found' } };
      }
      return { data: presigned };
    }

    const record = await getKVRecord(store.rows[0].id, key);

    if (!record) {
      // Apify SDK contract: a missing record must be 404 with
      // error.type='record-not-found'. apify-client's catchNotFoundOrThrow
      // is what turns this into `undefined` for the caller (Crawlee's
      // KeyValueStore.getValue, Actor.getInput, etc.). 204 was the wrong
      // status — the SDK treats it as a successful empty response and
      // returns a truthy stub instead of falling through.
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Record not found' } };
    }

    reply.header('content-type', record.contentType);
    return reply.send(record.value);
  });

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

      // Get or auto-create store (user-scoped)
      let store = await query<KVStoreRow>(
        'SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3',
        [storeId, storeId, request.user!.id]
      );

      if (!store.rows[0]) {
        // Auto-create with user ownership
        const id = storeId === 'default' ? nanoid() : storeId;
        await query(
          `INSERT INTO key_value_stores (id, name, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, storeId === 'default' ? null : storeId, request.user!.id]
        );
        store = await query<KVStoreRow>(
          'SELECT * FROM key_value_stores WHERE id = $1 AND user_id = $2',
          [id, request.user!.id]
        );
      }

      const body = request.body;
      // Pass Buffer bodies through unchanged. toString('utf-8') would corrupt
      // any non-UTF-8 bytes into U+FFFD replacement chars — fatal for binary
      // payloads (PNG screenshots, gzipped artifacts, etc.) that the Apify
      // SDK uploads via Actor.setValue(key, buffer, { contentType }).
      let data: Buffer | string;
      if (Buffer.isBuffer(body)) {
        data = body;
      } else if (typeof body === 'string') {
        data = body;
      } else {
        data = JSON.stringify(body);
      }

      await putKVRecord(store.rows[0]!.id, key, data, contentType);

      await query('UPDATE key_value_stores SET modified_at = NOW() WHERE id = $1', [
        store.rows[0]!.id,
      ]);

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
        'SELECT * FROM key_value_stores WHERE (id = $1 OR name = $2) AND user_id = $3',
        [storeId, storeId, request.user!.id]
      );

      if (!store.rows[0]) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Key-value store not found' } };
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
