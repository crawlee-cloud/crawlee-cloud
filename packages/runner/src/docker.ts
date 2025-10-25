/**
 * Docker container executor.
 * 
 * This module handles:
 * - Pulling Actor images
 * - Creating containers with proper environment variables
 * - Starting and monitoring containers
 * - Collecting logs and exit codes
 */

import Docker from 'dockerode';
import { Redis } from 'ioredis';
import { config } from './config.js';

export interface RunOptions {
  runId: string;
  actorId: string;
  image: string;
  
  // Environment variables to inject (Apify-compatible)
  env: Record<string, string>;
  
  // Resource limits
  memoryMb?: number;
  timeoutSecs?: number;
}

export interface RunResult {
  exitCode: number;
  logs: string;
  startedAt: Date;
  finishedAt: Date;
}

const docker = new Docker({
  socketPath: config.dockerSocketPath,
});

// Redis for log streaming
const redis = new Redis(config.redisUrl);

/**
 * Stream container logs to Redis in real-time.
 */
async function streamLogs(container: Docker.Container, runId: string): Promise<void> {
  const logStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });
  
  let buffer = '';
  
  logStream.on('data', async (chunk: Buffer) => {
    // Docker multiplexes stdout/stderr, first 8 bytes are header
    // For simplicity, we'll just process the raw output
    const text = chunk.toString('utf-8');
    buffer += text;
    
    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    for (const line of lines) {
      if (line.trim()) {
        // Clean Docker multiplex header if present (first 8 bytes per frame)
        const cleanLine = line.replace(/^[\x00-\x08]/g, '').trim();
        if (cleanLine) {
          const logEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            level: cleanLine.toLowerCase().includes('error') ? 'ERROR' : 
                   cleanLine.toLowerCase().includes('warn') ? 'WARN' : 'INFO',
            message: cleanLine,
          });
          
          // Store in Redis (capped at 1000 entries)
          await redis.rpush(`logs:${runId}`, logEntry);
          await redis.ltrim(`logs:${runId}`, -1000, -1);
          // Set expiry (24 hours)
          await redis.expire(`logs:${runId}`, 86400);
          // Publish for real-time subscribers
          await redis.publish(`logs:${runId}`, logEntry);
        }
      }
    }
  });
  
  // Flush remaining buffer on end
  logStream.on('end', async () => {
    if (buffer.trim()) {
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: buffer.trim(),
      });
      await redis.rpush(`logs:${runId}`, logEntry);
      await redis.ltrim(`logs:${runId}`, -1000, -1);
      await redis.expire(`logs:${runId}`, 86400);
      await redis.publish(`logs:${runId}`, logEntry);
    }
  });
}

/**
 * Execute an Actor in a Docker container.
 */
export async function executeRun(options: RunOptions): Promise<RunResult> {
  const {
    runId,
    actorId,
    image,
    env,
    memoryMb = config.defaultMemoryMb,
    timeoutSecs = config.defaultTimeoutSecs,
  } = options;
  
  console.log(`[${runId}] Starting container for Actor ${actorId}`);
  console.log(`[${runId}] Image: ${image}`);
  
  // Log start message to Redis
  const startLog = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    message: `Starting Actor ${actorId} with image ${image}`,
  });
  await redis.rpush(`logs:${runId}`, startLog);
  await redis.expire(`logs:${runId}`, 86400);
  
  const startedAt = new Date();
  
  // Build environment variables array
  const envArray = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  
  // Pull image if not exists
  try {
    await pullImageIfNeeded(image, runId);
  } catch (err) {
    console.error(`[${runId}] Failed to pull image:`, err);
    const errorLog = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `Failed to pull image: ${err}`,
    });
    await redis.rpush(`logs:${runId}`, errorLog);
    throw err;
  }
  
  // Create container
  const container = await docker.createContainer({
    Image: image,
    Env: envArray,
    HostConfig: {
      Memory: memoryMb * 1024 * 1024,
      MemorySwap: memoryMb * 1024 * 1024 * 2,
      NetworkMode: config.dockerNetwork,
      AutoRemove: false, // We'll remove after collecting logs
    },
    Labels: {
      'crawlee-cloud.run-id': runId,
      'crawlee-cloud.actor-id': actorId,
    },
  });
  
  console.log(`[${runId}] Container created: ${container.id}`);
  
  // Start streaming logs BEFORE starting container
  await streamLogs(container, runId);
  
  // Start container
  await container.start();
  console.log(`[${runId}] Container started`);
  
  // Wait for completion with timeout
  let exitCode = 0;
  let timedOut = false;
  
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('Container execution timed out'));
    }, timeoutSecs * 1000);
  });
  
  const waitPromise = container.wait();
  
  try {
    const result = await Promise.race([waitPromise, timeoutPromise]) as { StatusCode: number };
    exitCode = result.StatusCode;
  } catch (err) {
    if (timedOut) {
      console.log(`[${runId}] Container timed out, stopping...`);
      const timeoutLog = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: 'Container execution timed out',
      });
      await redis.rpush(`logs:${runId}`, timeoutLog);
      await container.stop({ t: 10 });
      exitCode = 143; // SIGTERM
    } else {
      throw err;
    }
  }
  
  const finishedAt = new Date();
  
  // Collect final logs
  const logStream = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
  });
  
  const logs = logStream.toString('utf-8');
  
  // Log finish message
  const finishLog = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: exitCode === 0 ? 'INFO' : 'ERROR',
    message: `Container finished with exit code ${exitCode}`,
  });
  await redis.rpush(`logs:${runId}`, finishLog);
  
  // Remove container
  await container.remove();
  console.log(`[${runId}] Container removed`);
  
  console.log(`[${runId}] Finished with exit code ${exitCode}`);
  
  return {
    exitCode,
    logs,
    startedAt,
    finishedAt,
  };
}

/**
 * Pull Docker image if not already present.
 */
async function pullImageIfNeeded(image: string, runId: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    console.log(`Image ${image} already exists`);
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `Image ${image} already exists locally`,
    });
    await redis.rpush(`logs:${runId}`, logEntry);
  } catch {
    console.log(`Pulling image ${image}...`);
    const pullStartLog = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `Pulling image ${image}...`,
    });
    await redis.rpush(`logs:${runId}`, pullStartLog);
    
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        
        docker.modem.followProgress(stream, (pullErr: Error | null) => {
          if (pullErr) {
            reject(pullErr);
          } else {
            resolve();
          }
        });
      });
    });
    
    console.log(`Image ${image} pulled successfully`);
    const pullDoneLog = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `Image ${image} pulled successfully`,
    });
    await redis.rpush(`logs:${runId}`, pullDoneLog);
  }
}

/**
 * Build Apify-compatible environment variables for a run.
 */
export function buildActorEnv(options: {
  runId: string;
  actorId: string;
  userId?: string;
  apiBaseUrl: string;
  token: string;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
  defaultRequestQueueId: string;
  memoryMbytes?: number;
  timeoutSecs?: number;
}): Record<string, string> {
  const {
    runId,
    actorId,
    userId,
    apiBaseUrl,
    token,
    defaultDatasetId,
    defaultKeyValueStoreId,
    defaultRequestQueueId,
    memoryMbytes = config.defaultMemoryMb,
    timeoutSecs = config.defaultTimeoutSecs,
  } = options;
  
  const timeoutAt = new Date(Date.now() + timeoutSecs * 1000).toISOString();
  
  return {
    // Identity
    APIFY_ACTOR_ID: actorId,
    APIFY_ACTOR_RUN_ID: runId,
    APIFY_USER_ID: userId || 'anonymous',
    
    // API connection
    APIFY_API_BASE_URL: apiBaseUrl,
    APIFY_TOKEN: token,
    APIFY_API_PUBLIC_BASE_URL: apiBaseUrl,
    
    // Storage IDs
    APIFY_DEFAULT_DATASET_ID: defaultDatasetId,
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: defaultKeyValueStoreId,
    APIFY_DEFAULT_REQUEST_QUEUE_ID: defaultRequestQueueId,
    
    // Runtime flags
    APIFY_IS_AT_HOME: '1',
    APIFY_HEADLESS: '1',
    APIFY_MEMORY_MBYTES: String(memoryMbytes),
    APIFY_TIMEOUT_AT: timeoutAt,
    
    // Input key
    APIFY_INPUT_KEY: 'INPUT',
    
    // Container info
    APIFY_CONTAINER_PORT: '4321',
    APIFY_CONTAINER_URL: `http://run-${runId}:4321`,
    
    // Also set CRAWLEE_ variants for newer crawlers
    CRAWLEE_STORAGE_DIR: '/tmp/storage',
  };
}

/**
 * Check Docker daemon connectivity.
 */
export async function checkDocker(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * List all running Actor containers.
 */
export async function listRunningContainers(): Promise<Docker.ContainerInfo[]> {
  const containers = await docker.listContainers({
    filters: {
      label: ['crawlee-cloud.run-id'],
    },
  });
  return containers;
}

/**
 * Stop a specific run's container.
 */
export async function stopRun(runId: string): Promise<void> {
  const containers = await docker.listContainers({
    filters: {
      label: [`crawlee-cloud.run-id=${runId}`],
    },
  });
  
  for (const containerInfo of containers) {
    const container = docker.getContainer(containerInfo.Id);
    await container.stop({ t: 10 });
    console.log(`Stopped container ${containerInfo.Id} for run ${runId}`);
  }
}
