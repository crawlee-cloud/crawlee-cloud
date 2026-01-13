import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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

// Register Swagger documentation
await app.register(swagger, {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'Crawlee Cloud API',
      description: 'Self-hosted Apify-compatible REST API for running web scrapers and automations. This API is designed to be compatible with the official Apify SDK.',
      version: process.env.npm_package_version ?? '0.1.0',
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
      contact: {
        name: 'Crawlee Cloud',
        url: 'https://github.com/crawlee-cloud/crawlee-cloud',
      },
    },
    externalDocs: {
      url: 'https://github.com/crawlee-cloud/crawlee-cloud',
      description: 'GitHub Repository',
    },
    servers: [
      {
        url: `http://localhost:${config.port}`,
        description: 'Local development server',
      },
    ],
    tags: [
      { name: 'Authentication', description: 'User authentication and authorization' },
      { name: 'Actors', description: 'Actor management and execution' },
      { name: 'Runs', description: 'Actor run management' },
      { name: 'Datasets', description: 'Dataset storage for structured data' },
      { name: 'Key-Value Stores', description: 'Key-value storage for arbitrary data' },
      { name: 'Request Queues', description: 'URL queue management for crawling' },
      { name: 'Logs', description: 'Run logs and streaming' },
      { name: 'Registry', description: 'Actor image registry' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from /auth/login',
        },
        apiKey: {
          type: 'apiKey',
          in: 'query',
          name: 'token',
          description: 'API token passed as query parameter',
        },
      },
    },
    security: [
      { bearerAuth: [] },
      { apiKey: [] },
    ],
  },
});

// Register Swagger UI
await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    tryItOutEnabled: true,
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

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
app.get('/health', {
  schema: {
    description: 'Health check endpoint',
    tags: ['Health'],
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          version: { type: 'string', example: '0.1.0' },
        },
      },
    },
  },
}, () => ({
  status: 'ok',
  version: process.env.npm_package_version ?? '1.0.0',
}));

// OpenAPI JSON endpoint
app.get('/openapi.json', {
  schema: {
    description: 'OpenAPI specification in JSON format',
    tags: ['Documentation'],
    response: {
      200: {
        type: 'object',
      },
    },
  },
}, () => app.swagger());

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
  console.log(`API Documentation: http://0.0.0.0:${String(config.port)}/docs`);
  console.log(`OpenAPI JSON: http://0.0.0.0:${String(config.port)}/openapi.json`);
}

void start();
export { app };
