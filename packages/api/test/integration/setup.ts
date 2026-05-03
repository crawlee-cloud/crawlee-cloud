/**
 * Integration test setup — builds a real Fastify app connected to
 * PostgreSQL, Redis, and MinIO from environment variables.
 *
 * Usage in test files:
 *   import { createTestApp, runMigrations, createTestUser } from './setup.js';
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export const TEST_CONFIG = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/crawlee_test',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  s3Endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  s3AccessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  s3SecretKey: process.env.S3_SECRET_KEY || 'minioadmin',
  s3Bucket: process.env.S3_BUCKET || 'crawlee-test',
  s3Region: process.env.S3_REGION || 'us-east-1',
  apiSecret: process.env.API_SECRET || 'integration-test-secret-at-least-32-characters',
};

/**
 * Build a Fastify instance with all routes registered,
 * backed by real database/redis/s3.
 */
export async function createTestApp(): Promise<FastifyInstance> {
  // Set env vars that the app's config.ts reads
  process.env.DATABASE_URL = TEST_CONFIG.databaseUrl;
  process.env.REDIS_URL = TEST_CONFIG.redisUrl;
  process.env.S3_ENDPOINT = TEST_CONFIG.s3Endpoint;
  process.env.S3_ACCESS_KEY = TEST_CONFIG.s3AccessKey;
  process.env.S3_SECRET_KEY = TEST_CONFIG.s3SecretKey;
  process.env.S3_BUCKET = TEST_CONFIG.s3Bucket;
  process.env.S3_REGION = TEST_CONFIG.s3Region;
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.API_SECRET = TEST_CONFIG.apiSecret;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.NODE_ENV = 'test';

  // Dynamic imports so env vars are read fresh
  const { initDatabase } = await import('../../src/db/index.js');
  const { initS3 } = await import('../../src/storage/s3.js');
  const { initRedis } = await import('../../src/storage/redis.js');
  const { authRoutes } = await import('../../src/routes/auth.js');
  const { actorsRoutes } = await import('../../src/routes/actors.js');
  const { runsRoutes } = await import('../../src/routes/runs.js');
  const { datasetsRoutes } = await import('../../src/routes/datasets.js');
  const { keyValueStoresRoutes } = await import('../../src/routes/key-value-stores.js');
  const { requestQueuesRoutes } = await import('../../src/routes/request-queues.js');
  const { logsRoutes } = await import('../../src/routes/logs.js');
  const { systemRoutes } = await import('../../src/routes/system.js');

  await initDatabase();
  await initS3();
  await initRedis();

  const app = Fastify({ logger: false });

  // Mirror the content-type parsers registered in src/index.ts so the test
  // app accepts the same payloads as production (binary uploads, form bodies).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body || {})
  );
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body)
  );

  // Mirror production's ZodError → 400 handler (src/index.ts). Without this,
  // validation failures bubble up as 500s and tests can't tell a real bug from
  // a malformed request.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          type: 'validation_error',
          message: 'Validation failed',
          details: error.errors,
        },
      });
    }
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: { type: error.name, message: error.message },
    });
  });

  await authRoutes(app);
  await app.register(actorsRoutes, { prefix: '/v2' });
  await app.register(runsRoutes, { prefix: '/v2' });
  await app.register(datasetsRoutes, { prefix: '/v2' });
  await app.register(keyValueStoresRoutes, { prefix: '/v2' });
  await app.register(requestQueuesRoutes, { prefix: '/v2' });
  await app.register(logsRoutes, { prefix: '/v2' });
  await app.register(systemRoutes, { prefix: '/v2' });

  await app.ready();
  return app;
}

/**
 * Run database migrations.
 */
export async function runMigrations(): Promise<void> {
  const { migrate } = await import('../../src/db/migrate.js');
  await migrate();
}

/**
 * Create a test user and return a valid JWT token.
 */
export async function createTestUser(
  email = 'test@integration.local',
  password = 'testpassword123'
): Promise<{ userId: string; token: string }> {
  const { hashPassword, createToken } = await import('../../src/auth/index.js');
  const { pool } = await import('../../src/db/index.js');
  const { nanoid } = await import('nanoid');

  const userId = nanoid();
  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')
     ON CONFLICT (email) DO UPDATE SET password_hash = $3 RETURNING id`,
    [userId, email, passwordHash]
  );

  const token = createToken({ userId, email, role: 'user' });
  return { userId, token };
}

/**
 * Delete all rows from test tables (order matters for foreign keys).
 */
export async function cleanDatabase(): Promise<void> {
  const { pool } = await import('../../src/db/index.js');
  // Order matters: child rows before parents.
  // runs references actors/datasets/key_value_stores/request_queues with default RESTRICT,
  // so those parents must be deleted AFTER runs, not before.
  await pool.query(`
    DELETE FROM webhook_deliveries;
    DELETE FROM schedules;
    DELETE FROM webhooks;
    DELETE FROM runs;
    DELETE FROM actor_builds;
    DELETE FROM actor_versions;
    DELETE FROM requests;
    DELETE FROM request_queues;
    DELETE FROM key_value_stores;
    DELETE FROM datasets;
    DELETE FROM actors;
    DELETE FROM api_keys;
    DELETE FROM users;
  `);
}

/**
 * Ensure the S3 test bucket exists.
 */
export async function ensureS3Bucket(): Promise<void> {
  const s3 = new S3Client({
    endpoint: TEST_CONFIG.s3Endpoint,
    region: TEST_CONFIG.s3Region,
    credentials: {
      accessKeyId: TEST_CONFIG.s3AccessKey,
      secretAccessKey: TEST_CONFIG.s3SecretKey,
    },
    forcePathStyle: true,
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: TEST_CONFIG.s3Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: TEST_CONFIG.s3Bucket }));
  }
}
