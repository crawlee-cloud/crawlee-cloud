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
import { config } from './config.js';
import {
  checkDocker,
  listRunningContainers,
  cleanupDocker,
  startPeriodicCleanup,
  stopPeriodicCleanup,
} from './docker.js';
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

  // Clean up stale Docker resources on startup
  await cleanupDocker();
  startPeriodicCleanup();

  // Initialize job queue
  console.log('Initializing job queue...');
  await initJobQueue();

  // Start heartbeat (publishes metrics to Redis for the scaler).
  // config.runnerId is the same identity claimNextRun stamps onto runs
  // (runner_id column) — heartbeats and cost attribution must agree.
  const heartbeatRedis = new Redis(config.redisUrl);
  const runnerId = config.runnerId;
  startHeartbeat(
    heartbeatRedis,
    runnerId,
    () => ({ count: getActiveRunCount(), ids: getActiveRunIds() }),
    config.maxConcurrentRuns
  );

  // Start processing runs (startProcessing logs its own banner — no duplicate here)
  await startProcessing();
}

function setupGracefulShutdown(): (reason: string) => void {
  const shutdownTimeoutSecs = parseInt(process.env.SHUTDOWN_TIMEOUT_SECS ?? '60', 10);
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, stopping run processor...`);

    stopProcessing();
    stopHeartbeat();
    stopPeriodicCleanup();

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

  return shutdown;
}

/**
 * The default Node behavior — exit on any unhandled rejection or uncaught
 * exception — is exactly wrong for this process. The runner supervises
 * containers whose ownership lives only in this process's memory
 * (activeRunIds); a hard exit orphans every one of them, and the systemd/
 * docker restart 5s later has no memory of them — they surface hours later
 * as zombie runs with frozen logs, reaped by the scaler at their deadline.
 * (Observed in prod 2026-07-15: one Redis blip in the pre-hardened log
 * path = 4 zombified runs.)
 */
function setupCrashGuards(shutdown: (reason: string) => void): void {
  // Rejections: log loudly and keep running. The historical offender —
  // Redis writes in the log path — is now caught at source
  // (createLogLineWriter / writeLifecycleLog); this is the backstop for
  // whatever we missed. A rejected promise doesn't corrupt shared state.
  process.on('unhandledRejection', (reason) => {
    console.error('[Runner] Unhandled promise rejection (continuing):', reason);
  });

  // Synchronous exceptions CAN leave arbitrary state behind — don't limp
  // along indefinitely, but don't orphan containers either: drain through
  // the same path as SIGTERM (stop claiming, wait for active runs up to
  // SHUTDOWN_TIMEOUT_SECS, exit) and let the supervisor restart us clean.
  process.on('uncaughtException', (err) => {
    console.error('[Runner] Uncaught exception — draining active runs, then restarting:', err);
    shutdown('uncaughtException');
  });
}

const shutdown = setupGracefulShutdown();
setupCrashGuards(shutdown);
main().catch((err: unknown) => {
  // Drain, don't exit(1): a rejection awaited inside main() is a HANDLED
  // rejection — the crash guards never see it — and this is the last
  // channel through which one error could still orphan active containers.
  // At boot (0 active runs) the drain exits immediately; the supervisor
  // (systemd/docker, Restart=always) restarts us either way.
  console.error('Runner failed:', err);
  shutdown('main() rejection');
});
