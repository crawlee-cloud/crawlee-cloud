import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { initDatabase } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { setupAdminUser } from './setup.js';

const app = Fastify({ logger: { level: config.logLevel } });

await app.register(cors, { origin: true });

// Register routes
await authRoutes(app);

// Health check
app.get('/health', async () => ({ status: 'ok' }));

async function start() {
  // Initialize database connection first
  await initDatabase();
  
  // Setup admin user from env vars
  await setupAdminUser();
  
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server on http://0.0.0.0:${config.port}`);
}

start();
export { app };


