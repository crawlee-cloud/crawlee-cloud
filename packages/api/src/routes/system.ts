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
import { loadScalerConfig } from '../scaler/index.js';

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

    const body: SystemInfo = {
      version: process.env.npm_package_version ?? '0.0.0',
      nodeVersion: process.version,
      storage,
      executionDefaults: {
        // Read from the same env vars the runner reads from. In single-host
        // dev (API + runner share env) this is accurate. In split deploys
        // these fields reflect API-side env; the runner can drift.
        maxConcurrentRuns: intEnv('MAX_CONCURRENT_RUNS', 10),
        defaultMemoryMb: intEnv('DEFAULT_MEMORY_MB', 1024),
        defaultTimeoutSecs: intEnv('DEFAULT_TIMEOUT_SECS', 3600),
      },
      scaler: {
        enabled: scalerCfg.enabled,
        provider: scalerCfg.provider,
        minRunners: scalerCfg.minRunners,
        maxRunners: scalerCfg.maxRunners,
      },
    };
    return { data: body };
  });
};
