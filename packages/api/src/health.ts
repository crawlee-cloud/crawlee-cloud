/**
 * Health check routes — liveness and readiness probes.
 */

import type { FastifyInstance } from 'fastify';
import { pool } from './db/index.js';
import { redis } from './storage/redis.js';
import { s3 } from './storage/s3.js';
import { config } from './config.js';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

export interface CheckResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface StorageHealth {
  db: CheckResult;
  redis: CheckResult;
  s3: CheckResult;
}

async function checkWithTimeout(
  name: string,
  fn: () => Promise<void>,
  timeoutMs = 3000
): Promise<CheckResult> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${name} health check timed out`)), timeoutMs)
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

/**
 * Run live probes against PostgreSQL, Redis, and S3 in parallel. Shared between
 * `/health/ready` (k8s readiness probe, unauthenticated) and `/v2/system/info`
 * (dashboard-facing aggregate, authenticated). Single implementation avoids
 * the two surfaces drifting apart in what "healthy" means.
 */
export async function runStorageHealthChecks(): Promise<StorageHealth> {
  const [db, redisCheck, s3Check] = await Promise.all([
    checkWithTimeout('db', async () => {
      await pool.query('SELECT 1');
    }),
    checkWithTimeout('redis', async () => {
      await redis.ping();
    }),
    checkWithTimeout('s3', async () => {
      await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
    }),
  ]);
  return { db, redis: redisCheck, s3: s3Check };
}

export function registerHealthRoutes(app: FastifyInstance): void {
  // Liveness — is the process alive?
  app.get('/health/live', () => ({ status: 'ok' }));

  // Readiness — can we serve traffic?
  app.get('/health/ready', async (_request, reply) => {
    const checks = await runStorageHealthChecks();
    const allOk = Object.values(checks).every((c) => c.status === 'ok');

    const body = {
      status: allOk ? 'ok' : 'degraded',
      checks,
    };

    return reply.status(allOk ? 200 : 503).send(body);
  });
}
