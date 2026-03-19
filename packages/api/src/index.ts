import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import compress from '@fastify/compress';
import { config } from './config.js';
import { enforceSecurityConfig } from './config-validator.js';
import { initDatabase } from './db/index.js';
import { initS3 } from './storage/s3.js';
import { initRedis } from './storage/redis.js';
import { authRoutes } from './routes/auth.js';
import { actorsRoutes } from './routes/actors.js';
import { runsRoutes } from './routes/runs.js';
import { datasetsRoutes } from './routes/datasets.js';
import { keyValueStoresRoutes } from './routes/key-value-stores.js';
import { requestQueuesRoutes } from './routes/request-queues.js';
import { logsRoutes } from './routes/logs.js';
import { registryRoutes } from './routes/registry.js';
import { usersRoutes } from './routes/users.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { schedulesRoutes } from './routes/schedules.js';
import { setupAdminUser } from './setup.js';
import { initScheduler } from './scheduler.js';
import { initScaler } from './scaler/index.js';
import { registry, httpRequestsTotal, httpRequestDuration } from './metrics.js';
import { registerHealthRoutes } from './health.js';

// Validate security configuration at startup
enforceSecurityConfig();

const app = Fastify({
  logger: { level: config.logLevel },
  // Increase body limit for batch requests (10MB)
  bodyLimit: 10 * 1024 * 1024,
});

// CORS restricted to configured origins
const allowedOrigins = config.corsOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// Enable compression/decompression (handles gzip request bodies from SDK)
await app.register(compress, { global: true });

// Add content type parsers for Apify SDK compatibility
// The SDK sends form-urlencoded for some endpoints
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    // For form-urlencoded, we just pass through - query params are used instead
    done(null, body || {});
  }
);

// Also handle text/plain for some SDK calls
app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

// Handle octet-stream for binary data
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

// Global Error Handler
app.setErrorHandler((error: any, request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        type: 'validation_error',
        message: 'Validation failed',
        details: error.errors,
      },
    });
  }

  // Default error handler fallback
  // If status code is 4xx, just send it, otherwise log it
  if (!error.statusCode || error.statusCode >= 500) {
    request.log.error(error);
  }

  const statusCode = error.statusCode || 500;
  reply.status(statusCode).send({
    error: {
      type: error.name,
      message: error.message,
    },
  });
});

// Metrics collection hooks
app.addHook('onRequest', (request, _reply, done) => {
  (request as any).__startTime = process.hrtime.bigint();
  done();
});

app.addHook('onResponse', (request, reply, done) => {
  const startTime = (request as any).__startTime as bigint | undefined;
  const route = request.routeOptions?.url ?? request.url;
  const method = request.method;
  const statusCode = String(reply.statusCode);

  httpRequestsTotal.inc({ method, route, status_code: statusCode });

  if (startTime) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    httpRequestDuration.observe({ method, route }, duration);
  }

  done();
});

// Register routes
await authRoutes(app);

// Register v2 API routes
await app.register(actorsRoutes, { prefix: '/v2' });
await app.register(runsRoutes, { prefix: '/v2' });
await app.register(datasetsRoutes, { prefix: '/v2' });
await app.register(keyValueStoresRoutes, { prefix: '/v2' });
await app.register(requestQueuesRoutes, { prefix: '/v2' });
await app.register(logsRoutes, { prefix: '/v2' });
await app.register(registryRoutes, { prefix: '/v2' });
await app.register(usersRoutes, { prefix: '/v2' });
await app.register(webhooksRoutes, { prefix: '/v2' });
await app.register(schedulesRoutes, { prefix: '/v2' });

// Health check routes (liveness + readiness)
registerHealthRoutes(app);

// Legacy health check
app.get('/health', () => ({
  status: 'ok',
  version: process.env.npm_package_version ?? '1.0.0',
}));

// Scaler status endpoint
app.get('/v2/scaler/status', async () => {
  const { getScalerStatus } = await import('./scaler/index.js');
  return { data: await getScalerStatus() };
});

// Prometheus metrics endpoint
app.get('/metrics', async (_request, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

async function start() {
  // Initialize database connection first
  await initDatabase();

  // Initialize S3 storage
  await initS3();

  // Initialize Redis
  await initRedis();

  // Setup admin user from env vars
  await setupAdminUser();

  // Start cron scheduler
  await initScheduler();

  // Start auto-scaler (disabled by default, no-op when SCALER_ENABLED != true)
  await initScaler();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server on http://0.0.0.0:${String(config.port)}`);
}

function setupGracefulShutdown(): void {
  const shutdownTimeoutSecs = parseInt(process.env.SHUTDOWN_TIMEOUT_SECS ?? '60', 10);
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `Received ${signal}, shutting down gracefully (timeout: ${String(shutdownTimeoutSecs)}s)...`
    );

    const forceExit = setTimeout(() => {
      console.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, shutdownTimeoutSecs * 1000);

    try {
      // 1. Stop scheduler and scaler
      const { unregisterAllSchedules } = await import('./scheduler.js');
      unregisterAllSchedules();
      const { stopScaler } = await import('./scaler/index.js');
      stopScaler();

      // 2. Close HTTP server (drain in-flight requests)
      await app.close();

      // 3. Close Redis
      const { redis: redisClient } = await import('./storage/redis.js');
      await redisClient.quit();

      // 4. Close database pool
      const { pool: dbPool } = await import('./db/index.js');
      await dbPool.end();

      console.log('Graceful shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

setupGracefulShutdown();
void start();
export { app };
