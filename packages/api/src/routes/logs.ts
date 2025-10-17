/**
 * WebSocket routes for real-time log streaming.
 * 
 * Clients connect to /v2/actor-runs/:runId/logs/stream
 * to receive live log updates via Redis pub/sub.
 */

import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../storage/redis.js';
import { extractToken, verifyToken } from '../auth/index.js';

// Store active WebSocket connections by run ID
const connections = new Map<string, Set<WebSocket>>();

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
   * WebSocket /v2/actor-runs/:runId/logs/stream - Real-time log stream
   */
  fastify.get<{ 
    Params: { runId: string };
    Querystring: { token?: string };
  }>(
    '/actor-runs/:runId/logs/stream',
    { websocket: true },
    async (socket, request) => {
      const { runId } = request.params;
      
      // Verify auth token from query string
      const token = request.query.token;
      if (!token || !verifyToken(token)) {
        socket.send(JSON.stringify({ error: 'Unauthorized' }));
        socket.close();
        return;
      }
      
      // Add to connections set
      if (!connections.has(runId)) {
        connections.set(runId, new Set());
      }
      connections.get(runId)!.add(socket);
      
      // Create Redis subscriber for this run
      const subscriber = redis.duplicate();
      await subscriber.subscribe(`logs:${runId}`);
      
      subscriber.on('message', (_channel: string, message: string) => {
        if (socket.readyState === 1) { // WebSocket.OPEN
          socket.send(message);
        }
      });
      
      // Send recent logs on connect
      const recentLogs = await redis.lrange(`logs:${runId}`, -50, -1);
      for (const log of recentLogs) {
        socket.send(log);
      }
      
      // Cleanup on close
      socket.on('close', async () => {
        connections.get(runId)?.delete(socket);
        if (connections.get(runId)?.size === 0) {
          connections.delete(runId);
        }
        await subscriber.unsubscribe(`logs:${runId}`);
        await subscriber.quit();
      });
    }
  );
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
