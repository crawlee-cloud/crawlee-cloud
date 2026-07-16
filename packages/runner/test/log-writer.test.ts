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
import {
  createLogLineWriter,
  boundedFlush,
  type LogRedis,
  type LogRedisPipeline,
} from '../src/docker.js';

type PipelineCmd = [op: string, ...args: unknown[]];
type ExecResult = Array<[Error | null, unknown]> | null;

/**
 * Pipeline-shaped mock (the writer issues one exec() per batch since the
 * PR #57 review). `onExec` receives that batch's commands and its ordinal;
 * return a result array / null, or throw to simulate a connection-level
 * failure. Landed rpush values accumulate in `landed` at exec-resolution
 * time — the observable "what actually reached Redis, in what order".
 */
function mockRedis(
  onExec?: (cmds: PipelineCmd[], batchNo: number) => Promise<ExecResult> | ExecResult
): { client: LogRedis; landed: string[]; batches: PipelineCmd[][]; pipelineCalls: () => number } {
  const landed: string[] = [];
  const batches: PipelineCmd[][] = [];
  let batchNo = 0;
  let pipelines = 0;
  const client: LogRedis = {
    pipeline(): LogRedisPipeline {
      pipelines++;
      const cmds: PipelineCmd[] = [];
      const p: LogRedisPipeline = {
        rpush: (key, value) => cmds.push(['rpush', key, value]),
        ltrim: (key, start, stop) => cmds.push(['ltrim', key, start, stop]),
        expire: (key, seconds) => cmds.push(['expire', key, seconds]),
        publish: (channel, message) => cmds.push(['publish', channel, message]),
        exec: async () => {
          const result = onExec
            ? await onExec(cmds, batchNo++)
            : cmds.map(() => [null, 1] as [Error | null, unknown]);
          batches.push(cmds);
          if (result !== null && !result.some(([err]) => err)) {
            for (const c of cmds) if (c[0] === 'rpush') landed.push(c[2] as string);
          }
          return result;
        },
      };
      return p;
    },
  };
  return { client, landed, batches, pipelineCalls: () => pipelines };
}

describe('createLogLineWriter', () => {
  it('pipelines rpush+publish per entry with one ltrim/expire per batch, in enqueue order', async () => {
    const { client, batches, landed } = mockRedis();
    const writer = createLogLineWriter(client, 'run-1');

    writer.enqueue(['a', 'b']);
    writer.enqueue(['c']);
    await writer.drain();

    expect(landed).toEqual(['a', 'b', 'c']);
    // Batch shape: per-entry rpush+publish (order-preserving for both the
    // list and subscribers), then a single cap-trim + TTL refresh — the
    // first batch setting the TTL is the no-immortal-key invariant.
    expect(batches[0]).toEqual([
      ['rpush', 'logs:run-1', 'a'],
      ['publish', 'logs:run-1', 'a'],
      ['rpush', 'logs:run-1', 'b'],
      ['publish', 'logs:run-1', 'b'],
      ['ltrim', 'logs:run-1', -1000, -1],
      ['expire', 'logs:run-1', 86400],
    ]);
    expect(batches).toHaveLength(2);
  });

  it('serializes batches even when an exec resolves slowly', async () => {
    const { client, landed } = mockRedis(async (cmds, batchNo) => {
      // First batch is slow — without serialization the second batch's
      // exec would be issued (and land) first.
      if (batchNo === 0) await new Promise((r) => setTimeout(r, 20));
      return cmds.map(() => [null, 1] as [Error | null, unknown]);
    });
    const writer = createLogLineWriter(client, 'run-1');

    writer.enqueue(['slow-1']);
    writer.enqueue(['fast-2']);
    await writer.drain();

    expect(landed).toEqual(['slow-1', 'fast-2']);
  });

  it('never throws or rejects when exec fails — drops the batch and keeps going', async () => {
    const { client, landed } = mockRedis((cmds, batchNo) => {
      if (batchNo === 0) throw new Error('MaxRetriesPerRequestError');
      return cmds.map(() => [null, 1] as [Error | null, unknown]);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const writer = createLogLineWriter(client, 'run-1');
    writer.enqueue(['doomed', 'also-dropped-with-batch']);
    writer.enqueue(['survives']);

    await expect(writer.drain()).resolves.toBeUndefined();
    expect(landed).toEqual(['survives']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped 2 log line(s)'));
    warn.mockRestore();
  });

  it('surfaces per-command errors from the exec result tuples (ioredis does not reject on those)', async () => {
    const { client } = mockRedis((cmds) =>
      cmds.map((c, i) =>
        i === 0
          ? ([new Error('OOM command not allowed'), null] as [Error | null, unknown])
          : ([null, 1] as [Error | null, unknown])
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const writer = createLogLineWriter(client, 'run-1');
    writer.enqueue(['x']);

    await expect(writer.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OOM command not allowed'));
    warn.mockRestore();
  });

  it('treats a null exec result (discarded pipeline) as a dropped batch', async () => {
    const { client } = mockRedis(() => null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const writer = createLogLineWriter(client, 'run-1');
    writer.enqueue(['x']);

    await expect(writer.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped 1 log line(s)'));
    warn.mockRestore();
  });

  it('drain resolves only after previously enqueued entries flushed', async () => {
    const { client, landed } = mockRedis(async (cmds) => {
      await new Promise((r) => setTimeout(r, 10));
      return cmds.map(() => [null, 1] as [Error | null, unknown]);
    });
    const writer = createLogLineWriter(client, 'run-1');

    writer.enqueue(['pending']);
    await writer.drain();

    expect(landed).toEqual(['pending']);
  });

  it('ignores empty enqueues', async () => {
    const { client, pipelineCalls } = mockRedis();
    const writer = createLogLineWriter(client, 'run-1');

    writer.enqueue([]);
    await writer.drain();

    expect(pipelineCalls()).toBe(0);
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
