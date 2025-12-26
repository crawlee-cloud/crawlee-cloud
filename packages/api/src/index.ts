import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { initDatabase } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { actorsRoutes } from './routes/actors.js';
import { runsRoutes } from './routes/runs.js';
import { datasetsRoutes } from './routes/datasets.js';
import { keyValueStoresRoutes } from './routes/key-value-stores.js';
import { requestQueuesRoutes } from './routes/request-queues.js';
import { logsRoutes } from './routes/logs.js';
import { registryRoutes } from './routes/registry.js';
import { setupAdminUser } from './setup.js';

const app = Fastify({ logger: { level: config.logLevel } });

await app.register(cors, { origin: true });

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

  // Setup admin user from env vars
  await setupAdminUser();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server on http://0.0.0.0:${String(config.port)}`);
}

void start();
export { app };
