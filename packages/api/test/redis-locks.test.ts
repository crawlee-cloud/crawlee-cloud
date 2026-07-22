/**
 * Tests for the Redis request-lock wrappers (storage/redis.ts) — the
 * only functions in that module with real branch logic: lockRequest's
 * SETNX 'OK' comparison and prolong/release ownership guards. ioredis
 * is module-mocked so initRedis() wires the fake client.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const redisCalls = {
  set: vi.fn(),
  get: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
  zadd: vi.fn(),
  zrange: vi.fn(),
  zrem: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      return redisCalls;
    }
  },
}));

import {
  initRedis,
  lockRequest,
  prolongLock,
  releaseLock,
  isLocked,
  addToQueueHead,
  getQueueHead,
  removeFromQueueHead,
} from '../src/storage/redis.js';

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await initRedis();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lockRequest', () => {
  it('acquires via SET NX with TTL and reports success on OK', async () => {
    redisCalls.set.mockResolvedValueOnce('OK');

    const locked = await lockRequest('q1', 'req1', 'client-a', 60);

    expect(locked).toBe(true);
    expect(redisCalls.set).toHaveBeenCalledWith('queue:q1:lock:req1', 'client-a', 'EX', 60, 'NX');
  });

  it('reports contention when the key already exists (SETNX returns null)', async () => {
    redisCalls.set.mockResolvedValueOnce(null);
    expect(await lockRequest('q1', 'req1', 'client-b', 60)).toBe(false);
  });
});

describe('prolongLock', () => {
  it('extends the TTL when the caller still holds the lock', async () => {
    redisCalls.get.mockResolvedValueOnce('client-a');
    redisCalls.expire.mockResolvedValueOnce(1);

    expect(await prolongLock('q1', 'req1', 'client-a', 120)).toBe(true);
    expect(redisCalls.expire).toHaveBeenCalledWith('queue:q1:lock:req1', 120);
  });

  it('refuses when another client holds the lock', async () => {
    redisCalls.get.mockResolvedValueOnce('client-b');

    expect(await prolongLock('q1', 'req1', 'client-a', 120)).toBe(false);
    expect(redisCalls.expire).not.toHaveBeenCalled();
  });

  it('refuses when the lock has expired (no holder)', async () => {
    redisCalls.get.mockResolvedValueOnce(null);
    expect(await prolongLock('q1', 'req1', 'client-a', 120)).toBe(false);
  });
});

describe('releaseLock', () => {
  it('deletes the key when the caller holds the lock', async () => {
    redisCalls.get.mockResolvedValueOnce('client-a');
    redisCalls.del.mockResolvedValueOnce(1);

    expect(await releaseLock('q1', 'req1', 'client-a')).toBe(true);
    expect(redisCalls.del).toHaveBeenCalledWith('queue:q1:lock:req1');
  });

  it('leaves a foreign lock in place', async () => {
    redisCalls.get.mockResolvedValueOnce('client-b');

    expect(await releaseLock('q1', 'req1', 'client-a')).toBe(false);
    expect(redisCalls.del).not.toHaveBeenCalled();
  });
});

describe('isLocked', () => {
  it('maps EXISTS 1/0 to boolean', async () => {
    redisCalls.exists.mockResolvedValueOnce(1);
    expect(await isLocked('q1', 'req1')).toBe(true);
    redisCalls.exists.mockResolvedValueOnce(0);
    expect(await isLocked('q1', 'req1')).toBe(false);
  });
});

describe('queue head helpers', () => {
  it('scores head entries by order number', async () => {
    await addToQueueHead('q1', 'req1', 42);
    expect(redisCalls.zadd).toHaveBeenCalledWith('queue:q1:head', 42, 'req1');
  });

  it('reads the first N entries', async () => {
    redisCalls.zrange.mockResolvedValueOnce(['req1', 'req2']);
    expect(await getQueueHead('q1', 2)).toEqual(['req1', 'req2']);
    expect(redisCalls.zrange).toHaveBeenCalledWith('queue:q1:head', 0, 1);
  });

  it('removes handled entries', async () => {
    await removeFromQueueHead('q1', 'req1');
    expect(redisCalls.zrem).toHaveBeenCalledWith('queue:q1:head', 'req1');
  });
});
