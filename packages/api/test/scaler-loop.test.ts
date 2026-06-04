/**
 * Integration tests for the scaler's main control loop.
 *
 * These exercise the full chain — `initScaler()` triggers one `scalingLoop()`
 * tick, which queries the DB for queue stats, reads heartbeats from Redis,
 * computes the desired runner count, and dispatches `createRunner`/
 * `destroyRunner` calls to the provider.
 *
 * What's locked down here that the provider tests can't catch:
 *   - Scale-up actually fires when the queue has work (the e2e path)
 *   - Scale-down respects `SCALER_IDLE_TIMEOUT_SECS` (no flapping)
 *   - Busy runners (heartbeat says activeRuns > 0) are NOT destroyed
 *   - RUNNING runs keep their runner alive (you don't kill the runner
 *     that's executing the run)
 *   - Stale runners (no heartbeat for >3min) are marked draining but —
 *     by current design — are NOT auto-reaped (this is a known gap;
 *     test locks current behavior so a future fix is intentional)
 *
 * All external dependencies are mocked so this runs hermetically in <100ms.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  queryMock,
  redisGet,
  redisSet,
  redisScan,
  redisMget,
  noopCreate,
  noopDestroy,
  noopList,
  withAdvisoryLockMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisScan: vi.fn(),
  redisMget: vi.fn(),
  noopCreate: vi.fn(),
  noopDestroy: vi.fn(),
  noopList: vi.fn(),
  // Default: leader path — runs the work and returns its result.
  withAdvisoryLockMock: vi.fn(async (_id: number, work: (c: never) => Promise<unknown>) => ({
    acquired: true,
    result: await work({} as never),
  })),
}));

vi.mock('../src/db/index.js', () => ({
  query: queryMock,
  withAdvisoryLock: withAdvisoryLockMock,
  LOCK_IDS: { scaler: 0xc0de0002, retention: 0xc0debeef, setup: 0xc0de0001, scheduler: 0xc0de0003 },
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    get: redisGet,
    set: redisSet,
    scan: redisScan,
    mget: redisMget,
  },
}));

/** SCAN returns [cursor, keys]. Cursor='0' terminates the helper after one iteration. */
const scanResult = (keys: string[]): [string, string[]] => ['0', keys];

vi.mock('../src/scaler/providers/noop.js', () => ({
  NoopProvider: class {
    name = 'noop';
    createRunner = noopCreate;
    destroyRunner = noopDestroy;
    listRunners = noopList;
  },
}));

const { initScaler, stopScaler } = await import('../src/scaler/index.js');

interface FakeRunner {
  id: string;
  name?: string;
  ip: string;
  status: 'creating' | 'ready' | 'busy' | 'draining' | 'destroying';
  createdAt: Date;
  activeRuns: number;
}

function makeRunner(id: string, overrides: Partial<FakeRunner> = {}): FakeRunner {
  return {
    id,
    ip: id,
    status: 'ready',
    createdAt: new Date(), // recent — won't trigger the "no heartbeat for 3min" path
    activeRuns: 0,
    ...overrides,
  };
}

function dbRows(stats: { ready?: number; running?: number }) {
  const rows: { status: string; count: string }[] = [];
  if (stats.ready) rows.push({ status: 'READY', count: String(stats.ready) });
  if (stats.running) rows.push({ status: 'RUNNING', count: String(stats.running) });
  return { rows };
}

describe('scaler loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    queryMock.mockResolvedValue({ rows: [] });
    redisScan.mockResolvedValue(scanResult([]));
    redisMget.mockResolvedValue([]);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    noopList.mockResolvedValue([]);
    noopCreate.mockImplementation(async () =>
      makeRunner(`noop-${Math.random().toString(36).slice(2, 8)}`)
    );
    noopDestroy.mockResolvedValue(undefined);

    process.env.SCALER_ENABLED = 'true';
    process.env.SCALER_PROVIDER = 'noop';
    process.env.SCALER_MIN_RUNNERS = '0';
    process.env.SCALER_MAX_RUNNERS = '5';
    process.env.SCALER_RUNS_PER_RUNNER = '2';
    process.env.SCALER_SCALE_UP_THRESHOLD = '0';
    process.env.SCALER_POLL_INTERVAL_SECS = '9999'; // we only test the initial tick
    process.env.SCALER_IDLE_TIMEOUT_SECS = '300';
  });

  afterEach(() => {
    stopScaler();
  });

  describe('scale-up path', () => {
    it('creates runners proportional to queue depth', async () => {
      queryMock.mockResolvedValue(dbRows({ ready: 6 })); // ceil(6/2) = 3 desired
      noopList.mockResolvedValue([]); // current = 0

      await initScaler();

      expect(noopCreate).toHaveBeenCalledTimes(3);
      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('does not scale up beyond maxRunners under huge demand', async () => {
      queryMock.mockResolvedValue(dbRows({ ready: 100 }));
      noopList.mockResolvedValue([]);

      await initScaler();

      expect(noopCreate).toHaveBeenCalledTimes(5); // capped at SCALER_MAX_RUNNERS
    });
  });

  describe('scale-down path (run is done)', () => {
    it('does NOT destroy runners when queue empties but idle timeout has not elapsed', async () => {
      queryMock.mockResolvedValue({ rows: [] }); // queue empty
      noopList.mockResolvedValue([makeRunner('r1'), makeRunner('r2'), makeRunner('r3')]);
      // last activity was 60s ago — well within 300s timeout
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('destroys idle runners after the idle timeout elapses', async () => {
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('r1', { createdAt: new Date(Date.now() - 60_000) }),
        makeRunner('r2', { createdAt: new Date(Date.now() - 60_000) }),
        makeRunner('r3', { createdAt: new Date(Date.now() - 60_000) }),
      ]);
      // last activity 1 hour ago — well past 300s timeout
      redisGet.mockResolvedValue(String(Date.now() - 3_600_000));

      await initScaler();

      // desired=0 (min), current=3 → destroy all 3
      expect(noopDestroy).toHaveBeenCalledTimes(3);
    });

    it('keeps a runner alive while a RUNNING run is still in progress', async () => {
      // This is the "run takes a while but is still healthy" path.
      // The scaler must NOT scale down just because the queue has zero READY —
      // the RUNNING count still represents real work.
      queryMock.mockResolvedValue(dbRows({ ready: 0, running: 1 }));
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 1,
          healthy: true,
          cpuUsage: 0.3,
          memoryUsageRatio: 0.5,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 3_600_000)); // idle timer doesn't matter — there's demand

      await initScaler();

      expect(noopDestroy).not.toHaveBeenCalled();
      expect(noopCreate).not.toHaveBeenCalled(); // ceil(1/2)=1, current=1, no change
    });

    it('does not destroy busy runners even when scaling down', async () => {
      // Queue empty, idle timeout passed, but one runner is still executing.
      // The scaler must skip busy runners and only kill idle ones.
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('r1', { createdAt: new Date(0) }),
        makeRunner('r2', { createdAt: new Date(0) }),
        makeRunner('r3', { createdAt: new Date(0) }),
      ]);
      redisScan.mockResolvedValue(
        scanResult(['runner:heartbeat:r1', 'runner:heartbeat:r2', 'runner:heartbeat:r3'])
      );
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 0,
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.3,
        }),
        JSON.stringify({
          runnerId: 'r2',
          activeRuns: 2,
          healthy: true,
          cpuUsage: 0.5,
          memoryUsageRatio: 0.5,
        }), // busy
        JSON.stringify({
          runnerId: 'r3',
          activeRuns: 0,
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.3,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 3_600_000));

      await initScaler();

      // Only r1 and r3 should be destroyed; r2 is busy
      expect(noopDestroy).toHaveBeenCalledTimes(2);
      const destroyedIds = noopDestroy.mock.calls.map((c) => c[0]);
      expect(destroyedIds).toContain('r1');
      expect(destroyedIds).toContain('r3');
      expect(destroyedIds).not.toContain('r2');
    });
  });

  describe('dead-runner reaping', () => {
    it('reaps runners with no heartbeat for >3 minutes', async () => {
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('stuck-runner', { createdAt: new Date(Date.now() - 300_000) }), // 5min old, no heartbeat
      ]);
      redisScan.mockResolvedValue(scanResult([])); // no heartbeat
      redisGet.mockResolvedValue(String(Date.now() - 60_000)); // idle timeout NOT yet passed

      await initScaler();

      // Reaping is INDEPENDENT of idle timeout — dead runners are zombies,
      // not capacity. They get destroyed whether the queue is busy or quiet.
      expect(noopDestroy).toHaveBeenCalledWith('stuck-runner');
    });

    it('does not reap runners that are still booting (<3min old, no heartbeat)', async () => {
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('booting-runner', { createdAt: new Date(Date.now() - 30_000) }), // 30s old, still booting
      ]);
      redisScan.mockResolvedValue(scanResult([])); // heartbeat hasn't appeared yet
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('matches heartbeat by runner.name when id and ip do not match', async () => {
      // Regression for: cloud-init couldn't always set RUNNER_ID, so the
      // runner falls back to os.hostname() when publishing heartbeats. On
      // DO that hostname is the droplet *name* (e.g. "crawlee-runner-177...")
      // — different from the droplet *id* ("568518893") that listRunners
      // returns. Without a name-keyed fallback, every healthy runner was
      // marked dead and reaped after the threshold elapsed.
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('568518893', {
          name: 'crawlee-runner-1777711194251',
          ip: '161.35.56.254',
          createdAt: new Date(Date.now() - 700_000), // > default 600s threshold
        }),
      ]);
      // Heartbeat published under the hostname (= droplet name), not the id
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:crawlee-runner-1777711194251']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'crawlee-runner-1777711194251',
          activeRuns: 0,
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.3,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      // Without the name fallback, this runner would be reaped despite the
      // heartbeat being present in Redis under a key the scaler couldn't find.
      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('does not reap "draining" runners (alive but resource-stressed)', async () => {
      // Draining = high CPU/memory but heartbeat is present → alive,
      // possibly recovering. Reaping these would kill viable runners.
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([makeRunner('stressed-runner')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:stressed-runner']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'stressed-runner',
          activeRuns: 0,
          healthy: false, // → status='draining'
          cpuUsage: 0.99,
          memoryUsageRatio: 0.97,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('reaps a dead runner and ALSO scales up if the queue still has demand', async () => {
      // Capacity accounting after reap: dead runner doesn't count toward
      // currentCount, so the scaler correctly identifies the deficit.
      queryMock.mockResolvedValue(dbRows({ ready: 4 })); // ceil(4/2)=2 desired
      noopList.mockResolvedValue([
        makeRunner('dead-1', { createdAt: new Date(Date.now() - 300_000) }),
        makeRunner('alive-1'),
      ]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:alive-1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'alive-1',
          activeRuns: 0,
          healthy: true,
          cpuUsage: 0.2,
          memoryUsageRatio: 0.4,
        }),
      ]);

      await initScaler();

      // Reaped dead-1; remaining capacity = 1; desired = 2 → must create 1 more.
      // If reaping happened AFTER counting (the old bug), currentCount would
      // be 2 and no scale-up would happen — leaving demand unmet.
      expect(noopDestroy).toHaveBeenCalledWith('dead-1');
      expect(noopCreate).toHaveBeenCalledTimes(1);
    });

    it('survives a destroyRunner failure and continues the loop', async () => {
      // If the provider throws (e.g. transient DigitalOcean API error),
      // the loop must not abort — the next tick will retry.
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('zombie', { createdAt: new Date(Date.now() - 300_000) }),
      ]);
      redisScan.mockResolvedValue(scanResult([]));
      noopDestroy.mockRejectedValueOnce(new Error('transient API failure'));

      // Should not throw out of initScaler
      await expect(initScaler()).resolves.toBeUndefined();
    });

    it('keeps a failed-to-reap runner in the count to avoid over-provisioning', async () => {
      // Codex P1: if reaper drops a dead runner from the list before destroy
      // has actually succeeded, currentCount understates real capacity and
      // the scaler will spawn replacements on the next tick — exponentially
      // over-provisioning under sustained transient destroy failures.
      //
      // We verify by setting up: 1 dead runner, destroy fails, queue has
      // demand for 1 runner. If the dead runner were dropped, currentCount=0
      // and the scaler would create a NEW one. With the fix, currentCount=1
      // and no scale-up happens.
      queryMock.mockResolvedValue(dbRows({ ready: 1 })); // ceil(1/2)=1 desired
      noopList.mockResolvedValue([
        makeRunner('failed-reap', { createdAt: new Date(Date.now() - 300_000) }),
      ]);
      redisScan.mockResolvedValue(scanResult([])); // no heartbeat → marked 'dead'
      noopDestroy.mockRejectedValueOnce(new Error('transient API failure'));

      await initScaler();

      // Reap was attempted but failed; runner stays in the count.
      expect(noopDestroy).toHaveBeenCalledWith('failed-reap');
      // Critical: NO new runner spawned. The dead one is still counted as
      // capacity until destroy actually succeeds on a future tick.
      expect(noopCreate).not.toHaveBeenCalled();
    });
  });

  describe('disabled scaler', () => {
    it('is a no-op when SCALER_ENABLED is not "true"', async () => {
      process.env.SCALER_ENABLED = 'false';

      await initScaler();

      expect(queryMock).not.toHaveBeenCalled();
      expect(noopCreate).not.toHaveBeenCalled();
      expect(noopDestroy).not.toHaveBeenCalled();
    });
  });

  describe('activity tracking', () => {
    it('updates LAST_ACTIVITY when there is any queue activity', async () => {
      queryMock.mockResolvedValue(dbRows({ ready: 1 }));
      noopList.mockResolvedValue([]);

      await initScaler();

      const setCalls = redisSet.mock.calls;
      const activityCall = setCalls.find((c) => c[0] === 'scaler:last-activity');
      expect(activityCall).toBeDefined();
    });

    it('does NOT update LAST_ACTIVITY when queue is empty', async () => {
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([]);

      await initScaler();

      const activityCall = redisSet.mock.calls.find((c) => c[0] === 'scaler:last-activity');
      expect(activityCall).toBeUndefined();
    });
  });
});

describe('scalingLoop — leader election', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAdvisoryLockMock.mockReset();
    // Restore the leader-path default for tests that don't override
    withAdvisoryLockMock.mockImplementation(
      async (_id: number, work: (c: never) => Promise<unknown>) => ({
        acquired: true,
        result: await work({} as never),
      })
    );

    queryMock.mockResolvedValue({ rows: [] });
    redisScan.mockResolvedValue(scanResult([]));
    redisMget.mockResolvedValue([]);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    noopList.mockResolvedValue([]);
    noopCreate.mockImplementation(async () => ({
      id: `noop-${Math.random().toString(36).slice(2, 8)}`,
      ip: '',
      status: 'ready',
      createdAt: new Date(),
      activeRuns: 0,
    }));
    noopDestroy.mockResolvedValue(undefined);

    process.env.SCALER_PROVIDER = 'noop';
    process.env.SCALER_MIN_RUNNERS = '0';
    process.env.SCALER_MAX_RUNNERS = '5';
    process.env.SCALER_RUNS_PER_RUNNER = '2';
    process.env.SCALER_SCALE_UP_THRESHOLD = '0';
    process.env.SCALER_POLL_INTERVAL_SECS = '9999';
    process.env.SCALER_IDLE_TIMEOUT_SECS = '300';
  });

  it('follower path: no provider calls, no redis writes', async () => {
    withAdvisoryLockMock.mockResolvedValue({ acquired: false });
    // Re-import so wasLeader resets to undefined for this test
    vi.resetModules();
    const { initScaler: initFresh, stopScaler: stopFresh } = await import('../src/scaler/index.js');

    process.env.SCALER_ENABLED = 'true';
    await initFresh();

    expect(noopCreate).not.toHaveBeenCalled();
    expect(noopDestroy).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    stopFresh();
  });

  it('first observation logs "became leader" when acquired', async () => {
    vi.resetModules();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m) => {
      logs.push(typeof m === 'string' ? m : String(m));
    });
    queryMock.mockResolvedValue({ rows: [{ ready: 0, running: 0, total: 0 }] });
    redisScan.mockResolvedValue(scanResult([]));
    const { initScaler: initFresh, stopScaler: stopFresh } = await import('../src/scaler/index.js');

    process.env.SCALER_ENABLED = 'true';
    await initFresh();

    expect(logs.some((l) => l.includes('[Scaler] became leader'))).toBe(true);
    logSpy.mockRestore();
    stopFresh();
  });

  it('first observation logs "joining as follower" when not acquired', async () => {
    vi.resetModules();
    withAdvisoryLockMock.mockResolvedValue({ acquired: false });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m) => {
      logs.push(typeof m === 'string' ? m : String(m));
    });
    const { initScaler: initFresh, stopScaler: stopFresh } = await import('../src/scaler/index.js');

    process.env.SCALER_ENABLED = 'true';
    await initFresh();

    expect(logs.some((l) => l.includes('[Scaler] joining as follower'))).toBe(true);
    logSpy.mockRestore();
    stopFresh();
  });
});
