import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import { config } from './config.js';
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
import { setupAdminUser } from './setup.js';

const app = Fastify({
  logger: { level: config.logLevel },
  // Increase body limit for batch requests (10MB)
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(cors, { origin: true });

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

// Health check
app.get('/health', () => ({
  status: 'ok',
  version: process.env.npm_package_version ?? '1.0.0',
}));

async function start() {
  // Initialize database connection first
  await initDatabase();

  // Initialize S3 storage
  await initS3();

  // Initialize Redis
  await initRedis();

  // Setup admin user from env vars
  await setupAdminUser();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server on http://0.0.0.0:${String(config.port)}`);
}

void start();
export { app };
