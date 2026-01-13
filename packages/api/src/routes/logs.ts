/**
 * WebSocket routes for real-time log streaming.
 * 
 * Clients connect to /v2/actor-runs/:runId/logs/stream
 * to receive live log updates via Redis pub/sub.
 */

import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../storage/redis.js';

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v2/actor-runs/:runId/logs - Append log line (used by runner)
   */
  fastify.post<{
    Params: { runId: string };
    Body: { message: string; level?: string; timestamp?: string };
  }>('/actor-runs/:runId/logs', async (request, reply) => {
    const { runId } = request.params;
    const { message, level = 'INFO', timestamp = new Date().toISOString() } = request.body;
    
    const logEntry = JSON.stringify({ timestamp, level, message });
    
    // Store in Redis list (capped at 1000 entries)
    await redis.rpush(`logs:${runId}`, logEntry);
    await redis.ltrim(`logs:${runId}`, -1000, -1);
    
    // Publish to subscribers
    await redis.publish(`logs:${runId}`, logEntry);
    
    reply.status(201);
    return {};
  });

  /**
   * GET /v2/actor-runs/:runId/logs - Get stored logs
   */
  fastify.get<{
    Params: { runId: string };
    Querystring: { offset?: string; limit?: string };
  }>('/actor-runs/:runId/logs', async (request) => {
    const { runId } = request.params;
    const offset = parseInt(request.query.offset || '0', 10);
    const limit = parseInt(request.query.limit || '100', 10);
    
    const logs = await redis.lrange(`logs:${runId}`, offset, offset + limit - 1);
    
    return {
      data: {
        offset,
        limit,
        count: logs.length,
        items: logs.map(l => JSON.parse(l)),
      },
    };
  });

  /**
   * GET /v2/actor-runs/:runId/logs/stream - Stream logs via WebSocket
   */
  fastify.get<{
    Params: { runId: string };
  }>('/actor-runs/:runId/logs/stream', { websocket: true }, (connection, req) => {
    const { runId } = req.params;
    const subscriber = redis.duplicate();
    const channel = `logs:${runId}`;

    subscriber.subscribe(channel, (err) => {
      if (err) {
        req.log.error(`Failed to subscribe to Redis channel ${channel}`, err);
        connection.socket.send(JSON.stringify({ error: 'Failed to subscribe to log stream' }));
        connection.socket.close();
        return;
      }
      req.log.info(`Client subscribed to Redis channel ${channel}`);
    });

    subscriber.on('message', (_channel, message) => {
      connection.socket.send(message);
    });

    connection.socket.on('close', () => {
      req.log.info(`Client unsubscribed from Redis channel ${channel}`);
      subscriber.unsubscribe(channel);
      subscriber.quit();
    });
  });
};

/**
 * Broadcast a log message to all connected clients for a run.
 */
export async function broadcastLog(
  runId: string,
  message: string,
  level = 'INFO'
): Promise<void> {
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
  });
  
  await redis.rpush(`logs:${runId}`, logEntry);
  await redis.ltrim(`logs:${runId}`, -1000, -1);
  await redis.publish(`logs:${runId}`, logEntry);
}
