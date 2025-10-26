/**
 * Crawlee Platform Runner Service
 * 
 * This service:
 * 1. Polls for new Actor runs
 * 2. Spawns Docker containers with proper environment
 * 3. Monitors execution and updates status
 * 4. Triggers webhooks on completion
 */

import { config } from './config.js';
import { checkDocker, listRunningContainers } from './docker.js';
import { initJobQueue, startProcessing } from './queue.js';

async function main() {
  console.log('='.repeat(60));
  console.log('Crawlee Platform Runner');
  console.log('='.repeat(60));
  console.log(`API URL: ${config.apiBaseUrl}`);
  console.log(`Max concurrent runs: ${config.maxConcurrentRuns}`);
  console.log(`Default memory: ${config.defaultMemoryMb}MB`);
  console.log(`Default timeout: ${config.defaultTimeoutSecs}s`);
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
    console.log(`Found ${running.length} running Actor containers`);
  }
  
  // Initialize job queue
  console.log('Initializing job queue...');
  await initJobQueue();
  
  // Start processing runs
  console.log('Starting run processor...');
  await startProcessing();
}

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

main().catch((err) => {
  console.error('Runner failed:', err);
  process.exit(1);
});
