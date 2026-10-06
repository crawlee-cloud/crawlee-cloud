import Fastify from 'fastify';
import { config } from './config.js';
import { API_BODY_LIMIT, configureHttp } from './http-setup.js';
import { enforceSecurityConfig } from './config-validator.js';
import { initDatabase } from './db/index.js';
import { initS3 } from './storage/s3.js';
import { initRedis } from './storage/redis.js';
import { authRoutes } from './routes/auth.js';
import { registerV2Routes } from './routes/index.js';
import { requireAdmin } from './auth/middleware.js';
import { setupAdminUserGated } from './setup-gated.js';
import { initScheduler } from './scheduler.js';
import { initRetention, unregisterRetention } from './retention.js';
import { initScaler } from './scaler/index.js';
import { registry, httpRequestsTotal, httpRequestDuration } from './metrics.js';
import { registerHealthRoutes } from './health.js';
import { getApiVersion } from './version.js';

// Validate security configuration at startup
enforceSecurityConfig();

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: API_BODY_LIMIT,
});

// CORS, compression, content-type parsers, global error handler
await configureHttp(app);

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
await registerV2Routes(app);

// Health check routes (liveness + readiness)
registerHealthRoutes(app);

// Legacy health check
app.get('/health', () => ({
  status: 'ok',
  version: getApiVersion(),
}));

// Prometheus metrics endpoint - admin-only by default to avoid public
// process recon. Wrapped in an encapsulated plugin so the preHandler hook
// applies only here. Kept at root path so existing Prometheus scrape
// configs keep working.
//
// METRICS_PUBLIC=true is an opt-in escape hatch for self-hosted operators
// running on a private network where cluster-internal scrapes can't pass
// auth. In production we log a loud warning so it shows up in operator
// logs/alerts.
await app.register(async (instance) => {
  if (!config.metricsPublic) {
    instance.addHook('preHandler', requireAdmin);
  } else if (config.nodeEnv === 'production') {
    app.log.warn(
      'METRICS_PUBLIC=true in production — GET /metrics is unauthenticated; ' +
        'ensure the API is not reachable from untrusted networks.'
    );
  }

  instance.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});

async function start() {
  // Initialize database connection first
  await initDatabase();

  // Initialize S3 storage
  await initS3();

  // Initialize Redis
  await initRedis();

  // Setup admin user from env vars (leader-elected for multi-replica safety)
  await setupAdminUserGated();

  // Start cron scheduler
  await initScheduler();

  // Register retention reaper (no-op when RETENTION_ENABLED=false)
  initRetention();

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
      // 1. Stop scheduler, retention reaper, and scaler
      const { stopScheduler } = await import('./scheduler.js');
      stopScheduler();
      unregisterRetention();
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
