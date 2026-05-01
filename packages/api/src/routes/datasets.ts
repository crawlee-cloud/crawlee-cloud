/**
 * Dataset routes - Apify-compatible endpoints.
 *
 * Users call these endpoints via APIFY_API_BASE_URL.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import {
  putDatasetItem,
  listDatasetItems,
  iterateDatasetKeys,
  getDatasetItemByKey,
} from '../storage/s3.js';
import { authenticate } from '../auth/middleware.js';
import { CreateDatasetSchema } from '../schemas/datasets.js';

interface DatasetRow {
  id: string;
  name: string | null;
  user_id: string | null;
  created_at: Date;
  modified_at: Date;
  accessed_at: Date;
  item_count: number;
}

export const datasetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /v2/datasets - List datasets (user-scoped)
   */
  fastify.get('/datasets', async (request, _reply) => {
    const result = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [request.user!.id]
    );

    return {
      data: {
        total: result.rows.length,
        count: result.rows.length,
        offset: 0,
        limit: 100,
        items: result.rows.map(formatDataset),
      },
    };
  });

  /**
   * POST /v2/datasets - Create or get dataset
   */
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>(
    '/datasets',
    async (request, reply) => {
      const body = CreateDatasetSchema.parse(request.body || {});
      const name = request.query.name || body.name;

      if (name) {
        // Try to get existing for this user
        const existing = await query<DatasetRow>(
          'SELECT * FROM datasets WHERE name = $1 AND user_id = $2',
          [name, request.user!.id]
        );
        if (existing.rows[0]) {
          return { data: formatDataset(existing.rows[0]) };
        }
      }

      // Create new with user ownership
      const id = nanoid();
      const result = await query<DatasetRow>(
        `INSERT INTO datasets (id, name, user_id) VALUES ($1, $2, $3) RETURNING *`,
        [id, name || null, request.user!.id]
      );

      reply.status(201);
      return { data: formatDataset(result.rows[0]!) };
    }
  );

  /**
   * GET /v2/datasets/:datasetId - Get dataset info (user-scoped)
   */
  fastify.get<{ Params: { datasetId: string } }>('/datasets/:datasetId', async (request, reply) => {
    const { datasetId } = request.params;

    const result = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE (id = $1 OR name = $2) AND user_id = $3',
      [datasetId, datasetId, request.user!.id]
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Dataset not found' } };
    }

    // Update accessed_at
    await query('UPDATE datasets SET accessed_at = NOW() WHERE id = $1', [result.rows[0].id]);

    return { data: formatDataset(result.rows[0]) };
  });

  /**
   * DELETE /v2/datasets/:datasetId - Delete dataset (user-scoped)
   */
  fastify.delete<{ Params: { datasetId: string } }>(
    '/datasets/:datasetId',
    async (request, reply) => {
      const { datasetId } = request.params;

      const result = await query(
        'DELETE FROM datasets WHERE (id = $1 OR name = $2) AND user_id = $3 RETURNING id',
        [datasetId, datasetId, request.user!.id]
      );
      if (result.rowCount === 0) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Dataset not found' } };
      }
      reply.status(204);
    }
  );

  /**
   * GET /v2/datasets/:datasetId/items - List items
   */
  fastify.get<{
    Params: { datasetId: string };
    Querystring: { offset?: string; limit?: string; desc?: string; download?: string };
  }>('/datasets/:datasetId/items', async (request, reply) => {
    const { datasetId } = request.params;

    // Get dataset to confirm it exists and belongs to user
    const dataset = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE (id = $1 OR name = $2) AND user_id = $3',
      [datasetId, datasetId, request.user!.id]
    );

    if (!dataset.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Dataset not found' } };
    }

    // ?download=1 — stream the FULL dataset as a single JSON array file.
    // Browser opens it as a download; no in-memory materialization on either
    // server (chunked S3 GETs with bounded concurrency) or client. This
    // sidesteps the silent ~1000-item cap in listDatasetItems and the
    // browser-blob memory pressure on the dashboard side.
    if (request.query.download === '1' || request.query.download === 'true') {
      const dsId = dataset.rows[0].id;
      // setHeader on the raw response — reply.header() needs Fastify's
      // lifecycle to flush, but streaming via reply.raw bypasses that.
      // First propagate Fastify-prepared headers (CORS from @fastify/cors,
      // etc.) so the browser doesn't reject the response.
      const stream = reply.raw;
      for (const [k, v] of Object.entries(reply.getHeaders())) {
        if (v !== undefined) stream.setHeader(k, v);
      }
      stream.setHeader('content-type', 'application/json; charset=utf-8');
      stream.setHeader('content-disposition', `attachment; filename="dataset-${dsId}.json"`);
      stream.write('[');

      // Bounded concurrency: 16 parallel S3 GETs is enough to saturate a
      // local MinIO and still leaves headroom under AWS's per-prefix QPS cap.
      const CONCURRENCY = 16;
      let inflight: Array<Promise<{ idx: number; data: unknown }>> = [];
      let writeIdx = 0;
      let firstWritten = false;
      const buffer = new Map<number, unknown>();

      function drainBuffer() {
        while (buffer.has(writeIdx)) {
          const item = buffer.get(writeIdx);
          buffer.delete(writeIdx);
          stream.write((firstWritten ? ',' : '') + JSON.stringify(item));
          firstWritten = true;
          writeIdx++;
        }
      }

      let nextIdx = 0;
      for await (const key of iterateDatasetKeys(dsId)) {
        const myIdx = nextIdx++;
        inflight.push(getDatasetItemByKey(key).then((data) => ({ idx: myIdx, data })));
        if (inflight.length >= CONCURRENCY) {
          const settled = await Promise.all(inflight);
          for (const r of settled) buffer.set(r.idx, r.data);
          inflight = [];
          drainBuffer();
        }
      }
      const tail = await Promise.all(inflight);
      for (const r of tail) buffer.set(r.idx, r.data);
      drainBuffer();

      stream.write(']');
      stream.end();
      return reply;
    }

    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    // Get items from S3
    const { items, total } = await listDatasetItems(dataset.rows[0].id, { offset, limit });

    // Set pagination headers (Apify style)
    reply.header('x-apify-pagination-total', total);
    reply.header('x-apify-pagination-offset', offset);
    reply.header('x-apify-pagination-limit', limit);

    return items;
  });

  /**
   * POST /v2/datasets/:datasetId/items - Push items
   *
   * This is the key endpoint for Actor.pushData()!
   */
  fastify.post<{
    Params: { datasetId: string };
    Body: unknown;
  }>('/datasets/:datasetId/items', async (request, reply) => {
    const { datasetId } = request.params;
    let body = request.body;

    // Handle Buffer body from catch-all content-type parser
    if (Buffer.isBuffer(body)) {
      const bufferContent = body.toString('utf-8');
      try {
        body = JSON.parse(bufferContent);
      } catch {
        // If not valid JSON, treat as single item
        body = { raw: bufferContent };
      }
    }

    // Get or create dataset (user-scoped)
    let dataset = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE (id = $1 OR name = $2) AND user_id = $3',
      [datasetId, datasetId, request.user!.id]
    );

    if (!dataset.rows[0]) {
      // Auto-create if "default" or specific ID, with user ownership
      const id = datasetId === 'default' ? nanoid() : datasetId;
      await query(
        `INSERT INTO datasets (id, name, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, datasetId === 'default' ? null : datasetId, request.user!.id]
      );
      dataset = await query<DatasetRow>('SELECT * FROM datasets WHERE id = $1 AND user_id = $2', [
        id,
        request.user!.id,
      ]);
    }

    const ds = dataset.rows[0]!;

    // Handle single item or array
    const items = Array.isArray(body) ? body : [body];

    // Store each item in S3 in parallel
    // Apify batches are typically manageable size (e.g. 100-1000 items)
    // but we chunk them just in case to avoid file system/S3 limits
    const CHUNK_SIZE = 50;

    // Calculate new total count first so we know IDs
    const startCount = ds.item_count;

    // Process in chunks
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const promises = chunk.map((item, index) => {
        const itemIndex = startCount + i + index;
        return putDatasetItem(ds.id, itemIndex, item);
      });
      await Promise.all(promises);
    }

    const currentCount = startCount + items.length;

    // Update count
    await query('UPDATE datasets SET item_count = $1, modified_at = NOW() WHERE id = $2', [
      currentCount,
      ds.id,
    ]);

    reply.status(201);
    return {};
  });
};

function formatDataset(row: DatasetRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    accessedAt: row.accessed_at,
    itemCount: row.item_count,
    cleanItemCount: row.item_count,
    stats: {
      readCount: 0,
      writeCount: row.item_count,
      deleteCount: 0,
      storageBytes: 0, // Would need to track this in S3
    },
  };
}
