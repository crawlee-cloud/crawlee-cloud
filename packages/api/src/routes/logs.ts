/**
 * WebSocket routes for real-time log streaming.
 *
 * Clients connect to /v2/actor-runs/:runId/logs/stream
 * to receive live log updates via Redis pub/sub.
 */

import type { FastifyPluginAsync, RouteHandler } from 'fastify';
import { redis } from '../storage/redis.js';
import { query } from '../db/index.js';
import { authenticate } from '../auth/middleware.js';

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * Verify run ownership before log access
   */
  async function verifyRunOwnership(runId: string, userId: string): Promise<boolean> {
    const result = await query<{ id: string }>(
      'SELECT id FROM runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    return result.rows.length > 0;
  }

  /**
   * POST /v2/actor-runs/:runId/logs - Append log line (used by runner, user-scoped)
   */
  fastify.post<{
    Params: { runId: string };
    Body: { message: string; level?: string; timestamp?: string };
  }>('/actor-runs/:runId/logs', async (request, reply) => {
    const { runId } = request.params;

    // Verify run ownership
    if (!(await verifyRunOwnership(runId, request.user!.id))) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    const { message, level = 'INFO', timestamp = new Date().toISOString() } = request.body;

    const logEntry = JSON.stringify({ timestamp, level, message });

    // Store in Redis list (capped at 1000 entries)
    await redis.rpush(`logs:${runId}`, logEntry);
    await redis.ltrim(`logs:${runId}`, -1000, -1);
    // Same invariant as the runner-side writers: EVERY write refreshes the
    // 24h TTL, because the FIRST write of a run's log key must set it —
    // for a never-claimed run this POST can be that first write, and
    // without the expire the key is immortal.
    await redis.expire(`logs:${runId}`, 86400);

    // Publish to subscribers
    await redis.publish(`logs:${runId}`, logEntry);

    reply.status(201);
    return {};
  });

  /**
   * GET /v2/actor-runs/:runId/logs - Get stored logs (user-scoped)
   */
  fastify.get<{
    Params: { runId: string };
    Querystring: { offset?: string; limit?: string; tail?: string };
  }>('/actor-runs/:runId/logs', async (request, reply) => {
    const { runId } = request.params;

    // Verify run ownership
    if (!(await verifyRunOwnership(runId, request.user!.id))) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    const limit = Math.min(2000, Math.max(1, parseInt(request.query.limit || '500', 10) || 500));
    const tail = request.query.tail === 'true';

    // total is the authoritative count of log lines stored in Redis. We need
    // it so the UI can render "showing X-Y of Z" honestly, AND so tail mode
    // can compute offset = total - limit without a roundtrip.
    const key = `logs:${runId}`;
    const total = await redis.llen(key);

    let offset: number;
    if (tail) {
      // Tail mode: return the LAST `limit` lines. Operators triaging failed
      // runs read from the bottom — that's where the error is.
      offset = Math.max(0, total - limit);
    } else {
      const requested = parseInt(request.query.offset || '0', 10);
      offset = Math.max(0, Number.isFinite(requested) ? requested : 0);
    }

    const stop = Math.min(total - 1, offset + limit - 1);
    // lrange returns [] when start > stop — guard so we don't issue a useless call
    const logs = stop < offset ? [] : await redis.lrange(key, offset, stop);

    return {
      data: {
        offset,
        limit,
        total,
        count: logs.length,
        items: logs.map((l) => JSON.parse(l)),
      },
    };
  });

  /**
   * GET /v2/actor-runs/:runId/logs/raw  (canonical)
   * GET /v2/actor-runs/:runId/log       (Apify-compat alias — same payload)
   *
   * Stream the full log as plain text (one line per entry, "ISO LEVEL message"
   * format). Used by the dashboard's "View raw" button — the browser opens
   * the URL in a new tab, gets a downloadable text file, and never has to
   * render 50K log lines in DOM.
   *
   * The `/log` (singular) alias matches Apify's documented public endpoint so
   * apify-client and tooling targeting api.apify.com work unchanged when
   * pointed at a self-hosted instance.
   *
   * We chunk the Redis read (CHUNK lines at a time) so a 100K-line log doesn't
   * allocate the whole list in memory at once. Each chunk is written and
   * flushed before the next is fetched.
   */
  const rawLogHandler: RouteHandler<{ Params: { runId: string } }> = async (request, reply) => {
    const { runId } = request.params;

    if (!(await verifyRunOwnership(runId, request.user!.id))) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Run not found' } };
    }

    const key = `logs:${runId}`;
    const total = await redis.llen(key);

    // Set headers directly on the raw Node response — reply.header() needs
    // Fastify's reply lifecycle to flush, but we're streaming via reply.raw
    // and bypassing that. setHeader on raw is the supported escape hatch.
    // Propagate headers Fastify has already prepared (notably the CORS
    // ones from @fastify/cors's onRequest hook) onto the raw response —
    // bypassing reply.send() means we have to flush them ourselves.
    const stream = reply.raw;
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) stream.setHeader(k, v);
    }
    stream.setHeader('content-type', 'text/plain; charset=utf-8');
    // No Content-Disposition at all — `text/plain` with no filename hint
    // lets browsers default to rendering inline (any `filename=` even with
    // `inline` triggers download in Chromium/Playwright). Operators wanting
    // a file can Save Page As (Cmd-S / Ctrl-S).
    stream.setHeader('x-log-line-count', String(total));

    const CHUNK = 5000;

    for (let start = 0; start < total; start += CHUNK) {
      const stop = Math.min(start + CHUNK - 1, total - 1);
      const lines = await redis.lrange(key, start, stop);
      for (const raw of lines) {
        // Tolerate non-JSON lines (defensive — runner is supposed to write JSON,
        // but a bad write shouldn't break a download).
        try {
          const o = JSON.parse(raw) as { timestamp?: string; level?: string; message?: string };
          stream.write(`${o.timestamp ?? ''} ${o.level ?? ''} ${o.message ?? raw}\n`);
        } catch {
          stream.write(`${raw}\n`);
        }
      }
    }

    stream.end();
    // Tell Fastify we've handled the response stream ourselves.
    return reply;
  };

  fastify.get<{ Params: { runId: string } }>('/actor-runs/:runId/logs/raw', rawLogHandler);
  fastify.get<{ Params: { runId: string } }>('/actor-runs/:runId/log', rawLogHandler);

  // TODO: WebSocket streaming route requires @fastify/websocket plugin registration
  // Uncomment and configure when websocket support is needed
  // fastify.get('/actor-runs/:runId/logs/stream', { websocket: true }, ...)
};

/**
 * Broadcast a log message to all connected clients for a run.
 */
export async function broadcastLog(runId: string, message: string, level = 'INFO'): Promise<void> {
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
  });

  await redis.rpush(`logs:${runId}`, logEntry);
  await redis.ltrim(`logs:${runId}`, -1000, -1);
  await redis.expire(`logs:${runId}`, 86400); // see POST handler: first write must set the TTL
  await redis.publish(`logs:${runId}`, logEntry);
}
