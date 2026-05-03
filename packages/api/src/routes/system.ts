/**
 * System info — read-only aggregate the dashboard's Settings page needs in
 * one shot. Pulls from existing sources (health.ts, scaler config, runner
 * env vars) so the page doesn't have to fan out three calls and reconcile.
 *
 * Authenticated but not admin-only: the payload contains nothing that
 * fingerprints the deployment beyond the version (already on /health) and
 * up/down state of storage backends (already on /health/ready). The scaler
 * subset is deliberately limited — provider name + enabled flag + min/max,
 * never IPs or tokens (that's /v2/scaler/status, admin-only).
 */

import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/middleware.js';
import { runStorageHealthChecks, type StorageHealth } from '../health.js';
import { getProviderExecutionDefaults, loadScalerConfig } from '../scaler/index.js';
import { getApiVersion } from '../version.js';
import { config } from '../config.js';
import { query } from '../db/index.js';

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  storage: StorageHealth;
  executionDefaults: {
    maxConcurrentRuns: number;
    defaultMemoryMb: number;
    defaultTimeoutSecs: number;
  };
  scaler: {
    enabled: boolean;
    provider: string;
    minRunners: number;
    maxRunners: number;
  };
}

/**
 * Same int-env helper as the runner uses — non-finite or missing values fall
 * back to documented defaults rather than producing NaN downstream.
 */
function intEnv(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/system/info', async () => {
    const storage = await runStorageHealthChecks();
    const scalerCfg = loadScalerConfig();

    // When the auto-scaler is enabled, runners are separate machines whose
    // env is set by each provider's createRunner (cloud-init for
    // digitalocean, container env for local-docker). Reading API-side
    // MAX_CONCURRENT_RUNS in that case is misleading — the API doesn't
    // run actors. Source memory/timeout from PROVIDER_DEFAULTS so the
    // dashboard reports what THAT provider's runners actually use; values
    // differ (DO bumps memory to 2048, local-docker stays at the runner
    // default 1024). For single-host (scaler off, API and runner share
    // env), the API-side env is the right source.
    const executionDefaults = scalerCfg.enabled
      ? {
          maxConcurrentRuns: scalerCfg.runsPerRunner,
          ...getProviderExecutionDefaults(scalerCfg.provider),
        }
      : {
          maxConcurrentRuns: intEnv('MAX_CONCURRENT_RUNS', 10),
          defaultMemoryMb: intEnv('DEFAULT_MEMORY_MB', 1024),
          defaultTimeoutSecs: intEnv('DEFAULT_TIMEOUT_SECS', 3600),
        };

    const body: SystemInfo = {
      version: getApiVersion(),
      nodeVersion: process.version,
      storage,
      executionDefaults,
      scaler: {
        enabled: scalerCfg.enabled,
        provider: scalerCfg.provider,
        minRunners: scalerCfg.minRunners,
        maxRunners: scalerCfg.maxRunners,
      },
    };
    return { data: body };
  });

  // GET /v2/system/retention/status — admin-only summary of reaper state.
  fastify.get('/system/retention/status', async (request, reply) => {
    if (request.user?.role !== 'admin') {
      reply.status(403);
      return { error: { type: 'forbidden', message: 'admin only' } };
    }

    const { redis } = await import('../storage/redis.js');
    const tickInfo = await redis.hgetall('retention:last-tick');
    const lastTickAt: string | null = tickInfo?.at ?? null;
    const lastTickElapsedMs: number | null = tickInfo?.elapsed_ms
      ? parseInt(tickInfo.elapsed_ms, 10)
      : null;

    const counts = await query<{
      dataset: string;
      key_value_store: string;
      request_queue: string;
      run: string;
      total_tombstones: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE deleted_at > NOW() - INTERVAL '24 hours' AND resource_kind = 'dataset')         AS dataset,
         COUNT(*) FILTER (WHERE deleted_at > NOW() - INTERVAL '24 hours' AND resource_kind = 'key_value_store') AS key_value_store,
         COUNT(*) FILTER (WHERE deleted_at > NOW() - INTERVAL '24 hours' AND resource_kind = 'request_queue')   AS request_queue,
         COUNT(*) FILTER (WHERE deleted_at > NOW() - INTERVAL '24 hours' AND resource_kind = 'run')             AS run,
         COUNT(*)                                                                                                AS total_tombstones
       FROM retention_tombstones`
    );
    const row = counts.rows[0] ?? {
      dataset: '0',
      key_value_store: '0',
      request_queue: '0',
      run: '0',
      total_tombstones: '0',
    };

    return {
      data: {
        enabled: config.retentionEnabled,
        lastTickAt,
        lastTickElapsedMs,
        reapedLast24h: {
          dataset: parseInt(row.dataset, 10),
          key_value_store: parseInt(row.key_value_store, 10),
          request_queue: parseInt(row.request_queue, 10),
          run: parseInt(row.run, 10),
        },
        tombstoneRowCount: parseInt(row.total_tombstones, 10),
      },
    };
  });
};
