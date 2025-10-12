/**
 * Request Queue routes - Apify-compatible endpoints.
 * 
 * This is the most complex route - handles:
 * - Deduplication via uniqueKey
 * - Request locking for distributed crawling
 * - FIFO ordering
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { query, getClient as _getClient } from '../db/index.js';
import { 
  addToQueueHead, 
  getQueueHead as _getQueueHead, 
  removeFromQueueHead, 
  lockRequest, 
  releaseLock,
  isLocked as _isLocked 
} from '../storage/redis.js';

interface QueueRow {
  id: string;
  name: string | null;
  user_id: string | null;
  created_at: Date;
  modified_at: Date;
  accessed_at: Date;
  total_request_count: number;
  handled_request_count: number;
  pending_request_count: number;
  had_multiple_clients: boolean;
}

interface RequestRow {
  id: string;
  queue_id: string;
  unique_key: string;
  url: string;
  method: string;
  payload: string | null;
  retry_count: number;
  no_retry: boolean;
  error_messages: string[] | null;
  headers: Record<string, string> | null;
  user_data: Record<string, unknown> | null;
  handled_at: Date | null;
  order_no: number;
  locked_until: Date | null;
  locked_by: string | null;
}

export const requestQueuesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v2/request-queues - List queues
   */
  fastify.get('/request-queues', async () => {
    const result = await query<QueueRow>('SELECT * FROM request_queues ORDER BY created_at DESC LIMIT 100');
    
    return {
      data: {
        total: result.rows.length,
        count: result.rows.length,
        offset: 0,
        limit: 100,
        items: result.rows.map(formatQueue),
      },
    };
  });

  /**
   * POST /v2/request-queues - Create or get queue
   */
  fastify.post<{ Body: { name?: string }; Querystring: { name?: string } }>('/request-queues', async (request, reply) => {
    const name = request.query.name ?? request.body.name;
    
    if (name) {
      const existing = await query<QueueRow>(
        'SELECT * FROM request_queues WHERE name = $1',
        [name]
      );
      if (existing.rows[0]) {
        return { data: formatQueue(existing.rows[0]) };
      }
    }
    
    const id = nanoid();
    const result = await query<QueueRow>(
      `INSERT INTO request_queues (id, name) VALUES ($1, $2) RETURNING *`,
      [id, name ?? null]
    );
    
    reply.status(201);
    const queue = result.rows[0];
    if (!queue) {
      reply.status(500);
      return { error: { message: 'Failed to create queue' } };
    }
    return { data: formatQueue(queue) };
  });

  /**
   * GET /v2/request-queues/:queueId - Get queue info
   */
  fastify.get<{ Params: { queueId: string } }>('/request-queues/:queueId', async (request, reply) => {
    const { queueId } = request.params;
    
    const result = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!result.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request queue not found' } };
    }
    
    await query('UPDATE request_queues SET accessed_at = NOW() WHERE id = $1', [result.rows[0].id]);
    
    return { data: formatQueue(result.rows[0]) };
  });

  /**
   * DELETE /v2/request-queues/:queueId - Delete queue
   */
  fastify.delete<{ Params: { queueId: string } }>('/request-queues/:queueId', async (request, reply) => {
    const { queueId } = request.params;
    await query('DELETE FROM request_queues WHERE id = $1 OR name = $2', [queueId, queueId]);
    reply.status(204);
  });

  /**
   * GET /v2/request-queues/:queueId/head - Get queue head (next requests to process)
   */
  fastify.get<{
    Params: { queueId: string };
    Querystring: { limit?: string };
  }>('/request-queues/:queueId/head', async (request, reply) => {
    const { queueId } = request.params;
    const limit = parseInt(request.query.limit || '100', 10);
    
    const queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request queue not found' } };
    }
    
    // Get pending requests, ordered by order_no
    const requests = await query<RequestRow>(`
      SELECT * FROM requests 
      WHERE queue_id = $1 
        AND handled_at IS NULL
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY order_no ASC
      LIMIT $2
    `, [queue.rows[0].id, limit]);
    
    return {
      data: {
        limit,
        queueModifiedAt: queue.rows[0].modified_at,
        items: requests.rows.map(formatRequest),
      },
    };
  });

  /**
   * POST /v2/request-queues/:queueId/head/lock - Get AND lock requests
   * 
   * This is critical for distributed crawling!
   * Parameters come from query string, not body (Apify API compatibility)
   */
  fastify.post<{
    Params: { queueId: string };
    Querystring: { lockSecs?: string; limit?: string; clientKey?: string };
  }>('/request-queues/:queueId/head/lock', async (request, reply) => {
    const { queueId } = request.params;
    const lockSecs = parseInt(request.query.lockSecs ?? '60', 10);
    const limit = parseInt(request.query.limit ?? '25', 10);
    const clientKey = request.query.clientKey ?? nanoid();
    
    const queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request queue not found' } };
    }
    
    const qId = queue.rows[0].id;
    
    // Get pending, unlocked requests
    const requests = await query<RequestRow>(`
      SELECT * FROM requests 
      WHERE queue_id = $1 
        AND handled_at IS NULL
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY order_no ASC
      LIMIT $2
    `, [qId, limit]);
    
    const lockedRequests: RequestRow[] = [];
    const lockExpiresAt = new Date(Date.now() + lockSecs * 1000).toISOString();
    
    // Lock each request
    for (const req of requests.rows) {
      const locked = await lockRequest(qId, req.id, clientKey, lockSecs);
      if (locked) {
        // Also update DB for persistence
        await query(`
          UPDATE requests 
          SET locked_until = NOW() + INTERVAL '${lockSecs} seconds', locked_by = $1
          WHERE id = $2
        `, [clientKey, req.id]);
        lockedRequests.push(req);
      }
    }
    
    // Check if queue has any locked requests
    const lockedCheck = await query<{ count: string }>(`
      SELECT COUNT(*) as count FROM requests 
      WHERE queue_id = $1 AND locked_until > NOW()
    `, [qId]);
    const queueHasLockedRequests = parseInt(lockedCheck.rows[0]?.count ?? '0', 10) > 0;
    
    // Update hadMultipleClients if there are multiple client keys
    const clientsCheck = await query<{ count: string }>(`
      SELECT COUNT(DISTINCT locked_by) as count FROM requests 
      WHERE queue_id = $1 AND locked_by IS NOT NULL
    `, [qId]);
    const hadMultipleClients = parseInt(clientsCheck.rows[0]?.count ?? '0', 10) > 1;
    
    if (hadMultipleClients && !queue.rows[0].had_multiple_clients) {
      await query('UPDATE request_queues SET had_multiple_clients = true WHERE id = $1', [qId]);
    }
    
    return {
      data: {
        limit,
        lockSecs,
        clientKey,
        queueModifiedAt: queue.rows[0].modified_at,
        queueHasLockedRequests,
        hadMultipleClients: queue.rows[0].had_multiple_clients || hadMultipleClients,
        items: lockedRequests.map(req => ({
          ...formatRequest(req),
          lockExpiresAt,
        })),
      },
    };
  });

  /**
   * POST /v2/request-queues/:queueId/requests - Add request
   * 
   * DEDUPLICATION happens here via uniqueKey constraint!
   */
  fastify.post<{
    Params: { queueId: string };
    Body: {
      url: string;
      uniqueKey?: string;
      method?: string;
      payload?: string;
      headers?: Record<string, string>;
      userData?: Record<string, unknown>;
      noRetry?: boolean;
    };
    Querystring: { forefront?: string };
  }>('/request-queues/:queueId/requests', async (request, reply) => {
    const { queueId } = request.params;
    const forefront = request.query.forefront === 'true';
    const body = request.body;
    
    // Get or create queue
    let queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      const id = queueId === 'default' ? nanoid() : queueId;
      await query(
        `INSERT INTO request_queues (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, queueId === 'default' ? null : queueId]
      );
      queue = await query<QueueRow>('SELECT * FROM request_queues WHERE id = $1', [id]);
    }
    
    const qId = queue.rows[0]!.id;
    
    // Generate uniqueKey from URL if not provided
    const uniqueKey = body.uniqueKey || computeUniqueKey(body.url, body.method || 'GET', body.payload);
    
    // Check if already exists (DEDUPLICATION!)
    const existing = await query<RequestRow>(
      'SELECT * FROM requests WHERE queue_id = $1 AND unique_key = $2',
      [qId, uniqueKey]
    );
    
    if (existing.rows[0]) {
      return {
        data: {
          requestId: existing.rows[0].id,
          wasAlreadyPresent: true,
          wasAlreadyHandled: existing.rows[0].handled_at !== null,
        },
      };
    }
    
    // Insert new request
    const id = nanoid();
    
    // For forefront, use negative order_no to put at front
    const orderModifier = forefront ? -1 : 1;
    
    const result = await query<RequestRow>(`
      INSERT INTO requests (id, queue_id, unique_key, url, method, payload, headers, user_data, no_retry)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      id,
      qId,
      uniqueKey,
      body.url,
      body.method || 'GET',
      body.payload || null,
      body.headers ? JSON.stringify(body.headers) : null,
      body.userData ? JSON.stringify(body.userData) : null,
      body.noRetry || false,
    ]);
    
    // Update queue counts
    await query(`
      UPDATE request_queues 
      SET total_request_count = total_request_count + 1,
          pending_request_count = pending_request_count + 1,
          modified_at = NOW()
      WHERE id = $1
    `, [qId]);
    
    // Add to Redis head cache
    await addToQueueHead(qId, id, result.rows[0]!.order_no * orderModifier);
    
    reply.status(201);
    return {
      data: {
        requestId: id,
        wasAlreadyPresent: false,
        wasAlreadyHandled: false,
      },
    };
  });

  /**
   * POST /v2/request-queues/:queueId/requests/batch - Batch add requests
   */
  fastify.post<{
    Params: { queueId: string };
    Body: unknown;
    Querystring: { forefront?: string };
  }>('/request-queues/:queueId/requests/batch', async (request, _reply) => {
    const { queueId } = request.params;
    const _forefront = request.query.forefront === 'true';
    let body = request.body;
    
    // Handle Buffer body from content-type parser
    if (Buffer.isBuffer(body)) {
      const bufferContent = body.toString('utf-8');
      try {
        body = JSON.parse(bufferContent);
      } catch {
        body = [];
      }
    }
    
    const requests = Array.isArray(body) ? body as Array<{
      url: string;
      uniqueKey?: string;
      method?: string;
      payload?: string;
      userData?: Record<string, unknown>;
    }> : [];
    
    console.log(`[BATCH DEBUG] queueId=${queueId}, body type=${typeof body}, isArray=${Array.isArray(body)}, requests.length=${requests.length}`);
    
    // Get or create queue
    let queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      const id = queueId === 'default' ? nanoid() : queueId;
      await query(
        `INSERT INTO request_queues (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, queueId === 'default' ? null : queueId]
      );
      queue = await query<QueueRow>('SELECT * FROM request_queues WHERE id = $1', [id]);
    }
    
    const qId = queue.rows[0]!.id;
    const processedRequests: { requestId: string; uniqueKey: string; wasAlreadyPresent: boolean; wasAlreadyHandled: boolean }[] = [];
    const unprocessedRequests: { url: string; uniqueKey: string }[] = [];
    
    // Process requests in parallel chunks to improve performance
    const CHUNK_SIZE = 20; 
    
    for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
      const chunk = requests.slice(i, i + CHUNK_SIZE);
      
      const chunkResults = await Promise.all(chunk.map(async (req) => {
        const uniqueKey = req.uniqueKey || computeUniqueKey(req.url, req.method || 'GET', req.payload);
        
        try {
          // Check existing (Deduplication)
          const existing = await query<RequestRow>(
            'SELECT * FROM requests WHERE queue_id = $1 AND unique_key = $2',
            [qId, uniqueKey]
          );
          
          if (existing.rows[0]) {
            return {
              type: 'processed',
              data: {
                requestId: existing.rows[0].id,
                uniqueKey,
                wasAlreadyPresent: true,
                wasAlreadyHandled: existing.rows[0].handled_at !== null,
              }
            };
          }
          
          // Insert new
          const id = nanoid();
          await query(`
            INSERT INTO requests (id, queue_id, unique_key, url, method, payload, user_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [id, qId, uniqueKey, req.url, req.method || 'GET', req.payload, req.userData ? JSON.stringify(req.userData) : null]);
          
          return {
            type: 'processed',
            data: {
              requestId: id,
              uniqueKey,
              wasAlreadyPresent: false,
              wasAlreadyHandled: false,
            }
          };
        } catch (err) {
          console.error(`Error processing batch request element:`, err);
          return {
            type: 'unprocessed',
            data: { url: req.url, uniqueKey }
          };
        }
      }));

      // Aggregate results
      for (const result of chunkResults) {
        if (result.type === 'processed') {
          processedRequests.push(result.data as any);
        } else {
          unprocessedRequests.push(result.data as any);
        }
      }
    }
    
    // Update queue counts
    const newCount = processedRequests.filter(r => !r.wasAlreadyPresent).length;
    if (newCount > 0) {
      await query(`
        UPDATE request_queues 
        SET total_request_count = total_request_count + $1,
            pending_request_count = pending_request_count + $1,
            modified_at = NOW()
        WHERE id = $2
      `, [newCount, qId]);
    }
    
    return {
      data: {
        processedRequests,
        unprocessedRequests,
      },
    };
  });

  /**
   * GET /v2/request-queues/:queueId/requests/:requestId - Get request
   */
  fastify.get<{ Params: { queueId: string; requestId: string } }>(
    '/request-queues/:queueId/requests/:requestId',
    async (request, reply) => {
      const { queueId, requestId } = request.params;
      
      const result = await query<RequestRow>(`
        SELECT r.* FROM requests r
        JOIN request_queues q ON r.queue_id = q.id
        WHERE (q.id = $1 OR q.name = $1) AND r.id = $2
      `, [queueId, requestId]);
      
      if (!result.rows[0]) {
        reply.status(404);
        return { error: { message: 'Request not found' } };
      }
      
      return { data: formatRequest(result.rows[0]) };
    }
  );

  /**
   * PUT /v2/request-queues/:queueId/requests/:requestId - Update request
   * 
   * Used for markRequestHandled() and reclaimRequest()
   */
  fastify.put<{
    Params: { queueId: string; requestId: string };
    Body: {
      handledAt?: string;
      retryCount?: number;
      errorMessages?: string[];
      userData?: Record<string, unknown>;
    };
    Querystring: { forefront?: string; clientKey?: string };
  }>('/request-queues/:queueId/requests/:requestId', async (request, reply) => {
    const { queueId, requestId } = request.params;
    const updates = request.body;
    const _forefront = request.query.forefront === 'true';
    const clientKey = request.query.clientKey;
    
    const existingResult = await query<RequestRow>(`
      SELECT r.* FROM requests r
      JOIN request_queues q ON r.queue_id = q.id
      WHERE (q.id = $1 OR q.name = $1) AND r.id = $2
    `, [queueId, requestId]);
    
    if (!existingResult.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request not found' } };
    }
    
    const existing = existingResult.rows[0];
    
    // Validate clientKey if request is locked
    const isLocked = existing.locked_until && new Date(existing.locked_until) > new Date();
    if (isLocked && existing.locked_by && clientKey !== existing.locked_by) {
      reply.status(409);
      return { error: { message: 'Request is locked by another client' } };
    }
    
    const wasHandled = existing.handled_at !== null;
    const willBeHandled = updates.handledAt !== undefined;
    
    // Build update query
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;
    
    if (updates.handledAt !== undefined) {
      setClauses.push(`handled_at = $${paramIndex++}`);
      values.push(updates.handledAt);
    }
    if (updates.retryCount !== undefined) {
      setClauses.push(`retry_count = $${paramIndex++}`);
      values.push(updates.retryCount);
    }
    if (updates.errorMessages !== undefined) {
      setClauses.push(`error_messages = $${paramIndex++}`);
      values.push(updates.errorMessages);
    }
    if (updates.userData !== undefined) {
      setClauses.push(`user_data = $${paramIndex++}`);
      values.push(JSON.stringify(updates.userData));
    }
    
    // Clear lock when updating
    setClauses.push('locked_until = NULL');
    setClauses.push('locked_by = NULL');
    
    if (setClauses.length > 0) {
      values.push(requestId);
      await query(`UPDATE requests SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`, values);
    }
    
    // Release Redis lock
    await releaseLock(existing.queue_id, requestId, existing.locked_by || '');
    
    // Update queue counts if transitioning to handled
    if (!wasHandled && willBeHandled) {
      await query(`
        UPDATE request_queues 
        SET handled_request_count = handled_request_count + 1,
            pending_request_count = pending_request_count - 1,
            modified_at = NOW()
        WHERE id = $1
      `, [existing.queue_id]);
      
      // Remove from Redis head
      await removeFromQueueHead(existing.queue_id, requestId);
    }
    
    return {
      data: {
        requestId,
        wasAlreadyPresent: true,
        wasAlreadyHandled: wasHandled,
      },
    };
  });

  /**
   * PUT /v2/request-queues/:queueId/requests/:requestId/lock - Prolong lock
   * 
   * This is used by the SDK to extend the lock on requests while processing.
   */
  fastify.put<{
    Params: { queueId: string; requestId: string };
    Querystring: { lockSecs?: string; forefront?: string; clientKey?: string };
  }>('/request-queues/:queueId/requests/:requestId/lock', async (request, reply) => {
    const { queueId, requestId } = request.params;
    const lockSecs = parseInt(request.query.lockSecs ?? '60', 10);
    const clientKey = request.query.clientKey ?? '';
    
    const queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request queue not found' } };
    }
    
    // Check request exists
    const req = await query<RequestRow>(
      'SELECT * FROM requests WHERE id = $1 AND queue_id = $2',
      [requestId, queue.rows[0].id]
    );
    
    if (!req.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request not found' } };
    }
    
    // Prolong in Redis
    await lockRequest(queue.rows[0].id, requestId, clientKey, lockSecs);
    
    // Prolong in DB
    await query(`
      UPDATE requests 
      SET locked_until = NOW() + INTERVAL '${String(lockSecs)} seconds'
      WHERE id = $1
    `, [requestId]);
    
    return { data: { lockExpiresAt: new Date(Date.now() + lockSecs * 1000).toISOString() } };
  });

  /**
   * DELETE /v2/request-queues/:queueId/requests/:requestId/lock - Release lock
   */
  fastify.delete<{
    Params: { queueId: string; requestId: string };
    Querystring: { clientKey?: string; forefront?: string };
  }>('/request-queues/:queueId/requests/:requestId/lock', async (request, reply) => {
    const { queueId, requestId } = request.params;
    const { clientKey = '', forefront } = request.query;
    
    const queue = await query<QueueRow>(
      'SELECT * FROM request_queues WHERE id = $1 OR name = $2',
      [queueId, queueId]
    );
    
    if (!queue.rows[0]) {
      reply.status(404);
      return { error: { message: 'Request queue not found' } };
    }
    
    // Release in Redis
    await releaseLock(queue.rows[0].id, requestId, clientKey);
    
    // Clear in DB
    await query(`
      UPDATE requests 
      SET locked_until = NULL, locked_by = NULL
      WHERE id = $1
    `, [requestId]);
    
    reply.status(204);
  });
};

/**
 * Compute uniqueKey from URL, method, and optional payload.
 * Matches Apify's algorithm.
 */
function computeUniqueKey(url: string, method: string, payload?: string): string {
  // Normalize URL (basic version)
  let normalizedUrl = url.toLowerCase().trim();
  
  // Remove trailing slash
  if (normalizedUrl.endsWith('/')) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }
  
  // Remove fragment
  const hashIndex = normalizedUrl.indexOf('#');
  if (hashIndex !== -1) {
    normalizedUrl = normalizedUrl.slice(0, hashIndex);
  }
  
  // For extended unique key with payload
  if (method !== 'GET' && payload) {
    const crypto = require('crypto');
    const payloadHash = crypto.createHash('sha256').update(payload).digest('base64').slice(0, 8);
    return `${method}(${payloadHash}):${normalizedUrl}`;
  }
  
  return normalizedUrl;
}

function formatQueue(row: QueueRow) {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    accessedAt: row.accessed_at,
    totalRequestCount: row.total_request_count,
    handledRequestCount: row.handled_request_count,
    pendingRequestCount: row.pending_request_count,
    hadMultipleClients: row.had_multiple_clients,
  };
}

function formatRequest(row: RequestRow) {
  return {
    id: row.id,
    uniqueKey: row.unique_key,
    url: row.url,
    method: row.method,
    retryCount: row.retry_count,
    noRetry: row.no_retry,
    // Only include optional fields if they have values (SDK expects omitted, not null)
    ...(row.payload && { payload: row.payload }),
    ...(row.error_messages && { errorMessages: row.error_messages }),
    ...(row.headers && { headers: row.headers }),
    ...(row.user_data && { userData: row.user_data }),
    ...(row.handled_at && { handledAt: row.handled_at }),
  };
}
