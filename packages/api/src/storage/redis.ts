/**
 * Redis client for request queue head caching and locking.
 */

import { Redis } from 'ioredis';
import { config } from '../config.js';

export let redis: Redis;

export async function initRedis(): Promise<void> {
  redis = new Redis(config.redisUrl);
  
  redis.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });
  
  // Test connection
  await redis.ping();
  console.log('Redis connected successfully');
}

/**
 * Add request IDs to queue head (sorted set by order_no).
 */
export async function addToQueueHead(queueId: string, requestId: string, orderNo: number): Promise<void> {
  await redis.zadd(`queue:${queueId}:head`, orderNo, requestId);
}

/**
 * Get next N request IDs from queue head.
 */
export async function getQueueHead(queueId: string, limit: number): Promise<string[]> {
  return redis.zrange(`queue:${queueId}:head`, 0, limit - 1);
}

/**
 * Remove request from queue head.
 */
export async function removeFromQueueHead(queueId: string, requestId: string): Promise<void> {
  await redis.zrem(`queue:${queueId}:head`, requestId);
}

/**
 * Lock a request for processing.
 * Returns true if lock was acquired, false if already locked.
 */
export async function lockRequest(queueId: string, requestId: string, clientKey: string, lockSecs: number): Promise<boolean> {
  const lockKey = `queue:${queueId}:lock:${requestId}`;
  const result = await redis.set(lockKey, clientKey, 'EX', lockSecs, 'NX');
  return result === 'OK';
}

/**
 * Prolong an existing lock.
 */
export async function prolongLock(queueId: string, requestId: string, clientKey: string, lockSecs: number): Promise<boolean> {
  const lockKey = `queue:${queueId}:lock:${requestId}`;
  const currentHolder = await redis.get(lockKey);
  if (currentHolder !== clientKey) return false;
  await redis.expire(lockKey, lockSecs);
  return true;
}

/**
 * Release a lock.
 */
export async function releaseLock(queueId: string, requestId: string, clientKey: string): Promise<boolean> {
  const lockKey = `queue:${queueId}:lock:${requestId}`;
  const currentHolder = await redis.get(lockKey);
  if (currentHolder !== clientKey) return false;
  await redis.del(lockKey);
  return true;
}

/**
 * Check if request is locked.
 */
export async function isLocked(queueId: string, requestId: string): Promise<boolean> {
  const lockKey = `queue:${queueId}:lock:${requestId}`;
  return (await redis.exists(lockKey)) === 1;
}
