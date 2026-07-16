/**
 * createLogLineWriter — regression tests for the fire-and-forget log path.
 *
 * Background: streamLogs used to spawn one unawaited async closure per
 * Docker 'data' event, each with four sequential awaits per line. Two prod
 * consequences: (a) overlapping closures interleaved their rpushes, so
 * lines landed out of order (the "Container finished" marker was often not
 * the last list element); (b) a rejected Redis command (ioredis flushes
 * pending commands with MaxRetriesPerRequestError after 20 reconnect
 * attempts) became an unhandled rejection — fatal on Node 20 — killing the
 * runner and zombifying every concurrent run on the droplet. The writer
 * serializes writes per run and degrades write failures to dropped lines.
 */

import { describe, it, expect, vi } from 'vitest';
import { createLogLineWriter, boundedFlush, type LogRedis } from '../src/docker.js';

function mockRedis(overrides: Partial<LogRedis> = {}): LogRedis & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    rpush: vi.fn().mockImplementation((_key: string, value: string) => {
      order.push(value);
      return Promise.resolve(1);
    }),
    ltrim: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('createLogLineWriter', () => {
  it('writes rpush/ltrim/expire/publish for every entry, in enqueue order', async () => {
    const redis = mockRedis();
    const writer = createLogLineWriter(redis, 'run-1');

    writer.enqueue(['a', 'b']);
    writer.enqueue(['c']);
    await writer.drain();

    expect(redis.order).toEqual(['a', 'b', 'c']);
    expect(redis.rpush).toHaveBeenCalledWith('logs:run-1', 'a');
    expect(redis.ltrim).toHaveBeenCalledWith('logs:run-1', -1000, -1);
    expect(redis.expire).toHaveBeenCalledWith('logs:run-1', 86400);
    expect(redis.publish).toHaveBeenCalledWith('logs:run-1', 'c');
  });

  it('serializes batches even when individual writes resolve slowly', async () => {
    const order: string[] = [];
    const redis = mockRedis({
      rpush: vi.fn().mockImplementation((_key: string, value: string) => {
        // First batch is slow — without serialization the second batch's
        // rpush would be issued (and land) first.
        const delay = value.startsWith('slow') ? 20 : 0;
        return new Promise((resolve) => {
          setTimeout(() => {
            order.push(value);
            resolve(1);
          }, delay);
        });
      }),
    });
    const writer = createLogLineWriter(redis, 'run-1');

    writer.enqueue(['slow-1']);
    writer.enqueue(['fast-2']);
    await writer.drain();

    expect(order).toEqual(['slow-1', 'fast-2']);
  });

  it('never throws or rejects when a write fails — drops the batch and keeps going', async () => {
    let calls = 0;
    const redis = mockRedis({
      rpush: vi.fn().mockImplementation((_key: string, value: string) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('MaxRetriesPerRequestError'));
        redis.order.push(value);
        return Promise.resolve(1);
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const writer = createLogLineWriter(redis, 'run-1');
    writer.enqueue(['doomed', 'also-dropped-with-batch']);
    writer.enqueue(['survives']);

    await expect(writer.drain()).resolves.toBeUndefined();
    expect(redis.order).toEqual(['survives']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped 2 log line(s)'));
    warn.mockRestore();
  });

  it('drain resolves only after previously enqueued entries flushed', async () => {
    const redis = mockRedis({
      rpush: vi.fn().mockImplementation(
        (_key: string, value: string) =>
          new Promise((resolve) => {
            setTimeout(() => {
              redis.order.push(value);
              resolve(1);
            }, 10);
          })
      ),
    });
    const writer = createLogLineWriter(redis, 'run-1');

    writer.enqueue(['pending']);
    await writer.drain();

    expect(redis.order).toEqual(['pending']);
  });

  it('ignores empty enqueues', async () => {
    const redis = mockRedis();
    const writer = createLogLineWriter(redis, 'run-1');

    writer.enqueue([]);
    await writer.drain();

    expect(redis.rpush).not.toHaveBeenCalled();
  });
});

describe('boundedFlush', () => {
  // Regression: the original flush handle was
  // `Promise.race([ended, timeout]).then(() => drain())` — the timeout
  // bounded only the wait for stream 'end', and drain() was awaited
  // afterwards UNBOUNDED. Under a Redis outage (ioredis has no command
  // timeout; a black-holed connection never settles) executeRun's
  // `await flushLogs(2000)` stalled indefinitely: the run stayed RUNNING
  // past its deadline and SIGTERM blocked until forceExit(1).
  const never = new Promise<void>(() => undefined);

  it('awaits drain inside the bound when the stream has ended', async () => {
    const drain = vi.fn().mockResolvedValue(undefined);

    await boundedFlush(Promise.resolve(), drain, 1000);

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('resolves within the bound when drain never settles (Redis outage backlog)', async () => {
    const drain = vi.fn().mockReturnValue(never);

    // Rejects the promise via vitest's own timeout if the bound is broken.
    await boundedFlush(Promise.resolve(), drain, 20);

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('resolves within the bound when the stream never ends (wedged attach socket)', async () => {
    const drain = vi.fn();

    await boundedFlush(never, drain, 20);

    expect(drain).not.toHaveBeenCalled();
  });
});
