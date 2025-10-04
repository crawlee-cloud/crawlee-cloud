import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });

app.get('/health', async () => ({ status: 'ok' }));

async function start() {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server on http://0.0.0.0:${config.port}`);
}

start();
export { app };
