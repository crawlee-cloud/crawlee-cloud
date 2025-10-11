/**
 * Dataset routes - Apify-compatible endpoints.
 * 
 * Users call these endpoints via APIFY_API_BASE_URL.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query } from '../db/index.js';
import { putDatasetItem, listDatasetItems } from '../storage/s3.js';

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
  /**
   * GET /v2/datasets - List datasets
   */
  fastify.get('/datasets', async (_request, _reply) => {
    const result = await query<DatasetRow>('SELECT * FROM datasets ORDER BY created_at DESC LIMIT 100');
    
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
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>('/datasets', async (request, reply) => {
    const name = request.query.name || request.body?.name;
    
    if (name) {
      // Try to get existing
      const existing = await query<DatasetRow>(
        'SELECT * FROM datasets WHERE name = $1',
        [name]
      );
      if (existing.rows[0]) {
        return { data: formatDataset(existing.rows[0]) };
      }
    }
    
    // Create new
    const id = nanoid();
    const result = await query<DatasetRow>(
      `INSERT INTO datasets (id, name) VALUES ($1, $2) RETURNING *`,
      [id, name || null]
    );
    
    reply.status(201);
    return { data: formatDataset(result.rows[0]!) };
  });

  /**
   * GET /v2/datasets/:datasetId - Get dataset info
   */
  fastify.get<{ Params: { datasetId: string } }>('/datasets/:datasetId', async (request, reply) => {
    const { datasetId } = request.params;
    
    const result = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE id = $1 OR name = $2',
      [datasetId, datasetId]
    );
    
    if (!result.rows[0]) {
      reply.status(404);
      return { error: { message: 'Dataset not found' } };
    }
    
    // Update accessed_at
    await query('UPDATE datasets SET accessed_at = NOW() WHERE id = $1', [result.rows[0].id]);
    
    return { data: formatDataset(result.rows[0]) };
  });

  /**
   * DELETE /v2/datasets/:datasetId - Delete dataset
   */
  fastify.delete<{ Params: { datasetId: string } }>('/datasets/:datasetId', async (request, reply) => {
    const { datasetId } = request.params;
    
    await query('DELETE FROM datasets WHERE id = $1 OR name = $2', [datasetId, datasetId]);
    reply.status(204);
  });

  /**
   * GET /v2/datasets/:datasetId/items - List items
   */
  fastify.get<{ 
    Params: { datasetId: string };
    Querystring: { offset?: string; limit?: string; desc?: string };
  }>('/datasets/:datasetId/items', async (request, reply) => {
    const { datasetId } = request.params;
    const offset = parseInt(request.query.offset || '0', 10);
    const limit = parseInt(request.query.limit || '100', 10);
    
    // Get dataset to confirm it exists
    const dataset = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE id = $1 OR name = $2',
      [datasetId, datasetId]
    );
    
    if (!dataset.rows[0]) {
      reply.status(404);
      return { error: { message: 'Dataset not found' } };
    }
    
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
    
    // Get or create dataset
    let dataset = await query<DatasetRow>(
      'SELECT * FROM datasets WHERE id = $1 OR name = $2',
      [datasetId, datasetId]
    );
    
    if (!dataset.rows[0]) {
      // Auto-create if "default" or specific ID
      const id = datasetId === 'default' ? nanoid() : datasetId;
      await query(
        `INSERT INTO datasets (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, datasetId === 'default' ? null : datasetId]
      );
      dataset = await query<DatasetRow>('SELECT * FROM datasets WHERE id = $1', [id]);
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
    await query(
      'UPDATE datasets SET item_count = $1, modified_at = NOW() WHERE id = $2',
      [currentCount, ds.id]
    );
    
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
