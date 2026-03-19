/**
 * Crawlee Platform Runner Service
 *
 * This service:
 * 1. Polls for new Actor runs
 * 2. Spawns Docker containers with proper environment
 * 3. Monitors execution and updates status
 * 4. Triggers webhooks on completion
 */

import { Redis } from 'ioredis';
import os from 'os';
import { config } from './config.js';
import { checkDocker, listRunningContainers } from './docker.js';
import {
  initJobQueue,
  startProcessing,
  stopProcessing,
  getActiveRunCount,
  getActiveRunIds,
} from './queue.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';

async function main() {
  console.log('='.repeat(60));
  console.log('Crawlee Platform Runner');
  console.log('='.repeat(60));
  console.log(`API URL: ${config.apiBaseUrl}`);
  console.log(`Max concurrent runs: ${String(config.maxConcurrentRuns)}`);
  console.log(`Default memory: ${String(config.defaultMemoryMb)}MB`);
  console.log(`Default timeout: ${String(config.defaultTimeoutSecs)}s`);
  console.log('='.repeat(60));

  // Check Docker connectivity
  console.log('Checking Docker daemon...');
  const dockerOk = await checkDocker();
  if (!dockerOk) {
    console.error('Failed to connect to Docker daemon!');
    console.error(`Socket path: ${config.dockerSocketPath}`);
    process.exit(1);
  }
  console.log('Docker daemon connected');

  // Show currently running containers
  const running = await listRunningContainers();
  if (running.length > 0) {
    console.log(`Found ${String(running.length)} running Actor containers`);
  }

  // Initialize job queue
  console.log('Initializing job queue...');
  await initJobQueue();

  // Start heartbeat (publishes metrics to Redis for the scaler)
  const heartbeatRedis = new Redis(config.redisUrl);
  const runnerId = process.env.RUNNER_ID || os.hostname();
  startHeartbeat(
    heartbeatRedis,
    runnerId,
    () => ({ count: getActiveRunCount(), ids: getActiveRunIds() }),
    config.maxConcurrentRuns
  );

  // Start processing runs
  console.log('Starting run processor...');
  await startProcessing();
}

function setupGracefulShutdown(): void {
  const shutdownTimeoutSecs = parseInt(process.env.SHUTDOWN_TIMEOUT_SECS ?? '60', 10);
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, stopping run processor...`);

    stopProcessing();
    stopHeartbeat();

    const forceExit = setTimeout(() => {
      const active = getActiveRunCount();
      console.error(`Shutdown timeout exceeded with ${String(active)} active runs, forcing exit`);
      process.exit(1);
    }, shutdownTimeoutSecs * 1000);

    const checkInterval = setInterval(() => {
      const active = getActiveRunCount();
      if (active === 0) {
        clearInterval(checkInterval);
        clearTimeout(forceExit);
        console.log('All runs completed, exiting');
        process.exit(0);
      }
      console.log(`Waiting for ${String(active)} active run(s) to finish...`);
    }, 2000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

setupGracefulShutdown();
main().catch((err: unknown) => {
  console.error('Runner failed:', err);
  process.exit(1);
});
