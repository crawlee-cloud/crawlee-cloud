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
  // Default: leader path — runs the work and returns its result. The
  // pinned client's `query` routes to the same queryMock as the pooled
  // `query` helper, so transactional statements (BEGIN/UPDATE/INSERT/
  // COMMIT issued on the advisory-lock session) are observable alongside
  // the non-transactional ones.
  withAdvisoryLockMock: vi.fn(async (_id: number, work: (c: never) => Promise<unknown>) => ({
    acquired: true,
    result: await work({ query: queryMock } as never),
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

/**
 * Route queryMock based on SQL pattern. The scaler issues several
 * distinct queries per tick when there are RUNNING rows:
 *   1. `SELECT status, COUNT(*) ... GROUP BY status`  (queue depth)
 *   2. `SELECT id, started_at, timeout_secs FROM runs WHERE status = 'RUNNING'`
 *      (heartbeat-claim correlation + zombie-run reaper input)
 *   3. `UPDATE runs SET status = 'TIMED-OUT' ...`  (zombie reap)
 *   4. webhook lookup + delivery INSERT for reaped runs
 *
 * Tests that exercise the correlation path use this helper to give each
 * query its own response shape; tests that only need the GROUP BY can
 * keep using `queryMock.mockResolvedValue(dbRows(...))`.
 */
function setupQueryMock(opts: {
  stats: { ready?: number; running?: number };
  runningRows?: { id: string; started_at: Date | null; timeout_secs?: number | null }[];
  // Shape matches the reaper's batch SELECT: scoping columns are
  // filtered in memory, so mock rows must carry them.
  webhooks?: { id: string; actor_id: string | null; run_id: string | null }[];
  /** Make webhook-delivery INSERTs reject — exercises the reap ROLLBACK path. */
  rejectWebhookInserts?: boolean;
}) {
  queryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve({ rows: [] });
    }
    if (typeof sql === 'string' && sql.includes("FROM runs WHERE status = 'RUNNING'")) {
      return Promise.resolve({ rows: opts.runningRows ?? [] });
    }
    if (typeof sql === 'string' && sql.includes("SET status = 'TIMED-OUT'")) {
      const ids = (params?.[0] as string[]) ?? [];
      return Promise.resolve({ rows: ids.map((id) => ({ id, actor_id: 'actor-1' })) });
    }
    if (typeof sql === 'string' && sql.includes('FROM webhooks')) {
      return Promise.resolve({ rows: opts.webhooks ?? [] });
    }
    if (typeof sql === 'string' && sql.includes('INSERT INTO webhook_deliveries')) {
      if (opts.rejectWebhookInserts) {
        return Promise.reject(new Error('insert failed (simulated)'));
      }
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve(dbRows(opts.stats));
  });
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
      //
      // Post-v0.9.9 the activity gate uses runId correlation: the heartbeat
      // must claim the RUNNING row's id, or the row must be young enough
      // to be a fresh pickup. Both held simultaneously here is realistic —
      // heartbeats.runIds is what real runners publish (heartbeat.ts:119).
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [{ id: 'rX', started_at: new Date(Date.now() - 10_000) }],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 1,
          runIds: ['rX'],
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
    // Condemnation requires SCALER_REAPER_MISS_TICKS (default 3) consecutive
    // ticks without a heartbeat AND SCALER_REAPER_MISS_WINDOW_SECS (default
    // 90s) elapsed since the first miss. Seeding the persisted miss map at
    // threshold-1 with a first-miss timestamp past the window makes the
    // current tick the condemning one.
    function seedMisses(
      misses: Record<string, { c: number; t: number }>,
      idle = String(Date.now() - 60_000)
    ) {
      redisGet.mockImplementation(async (key: string) =>
        key === 'scaler:hb-misses' ? JSON.stringify(misses) : idle
      );
    }

    it('reaps runners with no heartbeat after 3 consecutive missed ticks', async () => {
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('stuck-runner', { createdAt: new Date(Date.now() - 300_000) }), // 5min old, no heartbeat
      ]);
      redisScan.mockResolvedValue(scanResult([])); // no heartbeat
      seedMisses({ 'stuck-runner': { c: 2, t: Date.now() - 120_000 } }); // this tick = 3rd miss, window elapsed

      await initScaler();

      // Reaping is INDEPENDENT of idle timeout — dead runners are zombies,
      // not capacity. They get destroyed whether the queue is busy or quiet.
      expect(noopDestroy).toHaveBeenCalledWith('stuck-runner');
    });

    it('does NOT reap on a single missing heartbeat (Redis blip)', async () => {
      // Regression for the 2026-07-09..12 incident: heartbeat keys live in
      // Redis with a 90s TTL, so one managed-Redis failover makes the whole
      // fleet look dead for a tick. Single-tick condemnation massacred every
      // busy runner and orphaned their claimed runs as zombie RUNNING rows.
      queryMock.mockResolvedValue({ rows: [] });
      noopList.mockResolvedValue([
        makeRunner('blipped-runner', { createdAt: new Date(Date.now() - 300_000) }), // well past boot grace
      ]);
      redisScan.mockResolvedValue(scanResult([])); // heartbeat missing THIS tick only
      seedMisses({}); // no prior misses recorded; idle timer recent (isolates the reaper path)

      await initScaler();

      expect(noopDestroy).not.toHaveBeenCalled();
      // The miss must be recorded for the next tick to build on. Entries
      // are `{ c, t }` where t is a wall-clock timestamp, so match the
      // count structurally rather than the exact serialized string.
      const missCall = redisSet.mock.calls.find((c) => c[0] === 'scaler:hb-misses');
      expect(missCall).toBeDefined();
      const [, missJson] = missCall ?? [];
      const persisted = JSON.parse(missJson as string) as Record<string, { c: number; t: number }>;
      expect(persisted['blipped-runner']).toMatchObject({ c: 1 });
      expect(persisted['blipped-runner'].t).toEqual(expect.any(Number));
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
      seedMisses({ 'dead-1': { c: 2, t: Date.now() - 120_000 } }); // this tick condemns dead-1

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
      seedMisses({ zombie: { c: 2, t: Date.now() - 120_000 } }); // condemned this tick → destroy is attempted
      noopDestroy.mockRejectedValueOnce(new Error('transient API failure'));

      // Should not throw out of initScaler
      await expect(initScaler()).resolves.toBeUndefined();
    });

    it('survives a failed miss-map write (set-only Redis failure) and completes the tick', async () => {
      // The miss-map persist is best-effort: losing it only restarts
      // counting (conservative). A Redis SET failure aborting the tick
      // would block scale-up/scale-down entirely — worse than the loss.
      queryMock.mockResolvedValue(dbRows({ ready: 2 })); // ceil(2/2)=1 desired
      noopList.mockResolvedValue([]);
      redisSet.mockImplementation(async (key: string) => {
        if (key === 'scaler:hb-misses') throw new Error('redis write refused');
        return 'OK';
      });

      await initScaler();

      // The tick must survive the failed write and still scale up.
      expect(noopCreate).toHaveBeenCalledTimes(1);
    });

    it('survives a corrupt miss map that parses to a non-object (e.g. "null")', async () => {
      // JSON.parse('"null"') doesn't throw — it returns null. Assigning
      // that to prevMisses would make evaluateDeadCandidates throw a
      // TypeError on property access, aborting EVERY tick until the
      // key's TTL clears it (the corrective write never runs because the
      // crash happens first). Corrupt state must degrade to counting
      // fresh, same as unparseable JSON.
      queryMock.mockResolvedValue(dbRows({ ready: 6 })); // demand: ceil(6/2)=3
      noopList.mockResolvedValue([
        makeRunner('r1', { createdAt: new Date(Date.now() - 300_000) }), // past boot grace
      ]);
      redisScan.mockResolvedValue(scanResult([])); // no heartbeat → miss-map path runs
      redisGet.mockImplementation(async (key: string) =>
        key === 'scaler:hb-misses' ? 'null' : String(Date.now() - 60_000)
      );

      await initScaler();

      // The tick completed: scale-up fired (desired 3, current 1 → +2)
      // and the runner was not condemned (fresh count, first miss).
      expect(noopCreate).toHaveBeenCalledTimes(2);
      expect(noopDestroy).not.toHaveBeenCalled();
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
      seedMisses({ 'failed-reap': { c: 2, t: Date.now() - 120_000 } }); // condemned this tick
      noopDestroy.mockRejectedValueOnce(new Error('transient API failure'));

      await initScaler();

      // Reap was attempted but failed; runner stays in the count.
      expect(noopDestroy).toHaveBeenCalledWith('failed-reap');
      // Critical: NO new runner spawned. The dead one is still counted as
      // capacity until destroy actually succeeds on a future tick.
      expect(noopCreate).not.toHaveBeenCalled();
    });
  });

  describe('zombie-run reaping', () => {
    const HOUR = 3_600_000;

    function updateCalls() {
      return queryMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes("SET status = 'TIMED-OUT'")
      );
    }

    it('terminalizes an unclaimed RUNNING row past its timeout and enqueues its webhook', async () => {
      // The 2026-07-13 incident shape: owning runner destroyed, row stuck
      // RUNNING for days against a 3600s timeout. Nobody enforces
      // timeout_secs once the owner dies — except this reaper.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'ghost', started_at: new Date(Date.now() - 20 * HOUR), timeout_secs: 3600 },
        ],
        webhooks: [{ id: 'wh-1', actor_id: null, run_id: null }],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 0,
          runIds: [], // live runner, but it does NOT claim 'ghost'
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.2,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      const updates = updateCalls();
      expect(updates).toHaveLength(1);
      expect(updates[0][1]).toEqual([['ghost']]);
      // Reaper UPDATE must refresh modified_at like the runner's terminal
      // UPDATE does — keeps dashboard recency sorting honest for reaped runs.
      expect(updates[0][0] as string).toContain('modified_at = NOW()');
      // finished_at must be the run's own deadline, not the reap moment.
      // Zombies are discovered hours or days after their runner died;
      // stamping NOW() made an 8h-dead run display an 8h runtime against
      // a 3600s timeout (and skewed duration stats). Apify semantics: a
      // timed-out run finishes at its timeout.
      expect(updates[0][0] as string).toContain(
        "finished_at = started_at + (COALESCE(timeout_secs, 3600) * interval '1 second')"
      );
      expect(updates[0][0] as string).not.toContain('finished_at = NOW()');
      // Webhook handed to the runner-side retry processor via next_retry_at=NOW()
      const inserts = queryMock.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('INSERT INTO webhook_deliveries')
      );
      expect(inserts).toHaveLength(1);
      expect(inserts[0][0] as string).toContain('NOW()');
      expect((inserts[0][1] as unknown[])[1]).toBe('wh-1');
      expect((inserts[0][1] as unknown[])[2]).toBe('ghost');

      // Atomicity: the terminal UPDATE and the webhook enqueue must share
      // one transaction on the advisory-lock client. A crash between them
      // previously lost the TIMED_OUT delivery forever — the run was no
      // longer RUNNING, so no later tick would re-discover it.
      const sqls = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const beginIdx = sqls.indexOf('BEGIN');
      const commitIdx = sqls.indexOf('COMMIT');
      const updateIdx = sqls.findIndex((s) => s.includes("SET status = 'TIMED-OUT'"));
      const insertIdx = sqls.findIndex((s) => s.includes('INSERT INTO webhook_deliveries'));
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(commitIdx).toBeGreaterThan(beginIdx);
      expect(updateIdx).toBeGreaterThan(beginIdx);
      expect(updateIdx).toBeLessThan(commitIdx);
      expect(insertIdx).toBeGreaterThan(updateIdx);
      expect(insertIdx).toBeLessThan(commitIdx);
    });

    it('does not enqueue deliveries for webhooks scoped to a different actor or run', async () => {
      // Scoping moved from SQL to memory when the per-run SELECT was
      // hoisted out of the transaction (one batch query) — this pins the
      // in-memory filter so a refactor can't silently fan out global
      // deliveries. The reap UPDATE mock reports actor_id 'actor-1'.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'ghost', started_at: new Date(Date.now() - 20 * HOUR), timeout_secs: 3600 },
        ],
        webhooks: [
          { id: 'wh-other-actor', actor_id: 'someone-else', run_id: null },
          { id: 'wh-other-run', actor_id: null, run_id: 'not-ghost' },
        ],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult([]));
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(updateCalls()).toHaveLength(1); // reap still happens
      const inserts = queryMock.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('INSERT INTO webhook_deliveries')
      );
      expect(inserts).toHaveLength(0); // ...but neither webhook matches
    });

    it('leaves a heartbeat-claimed run alone no matter how old', async () => {
      // Timeout enforcement for OWNED runs stays with the owning runner.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'long', started_at: new Date(Date.now() - 20 * HOUR), timeout_secs: 3600 },
        ],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 1,
          runIds: ['long'],
          healthy: true,
          cpuUsage: 0.3,
          memoryUsageRatio: 0.5,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(updateCalls()).toHaveLength(0);
    });

    it('leaves an unclaimed run alone while still inside its timeout window', async () => {
      // Unclaimed-but-in-window could be a heartbeat blip; the run may
      // finish normally under its real owner.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'inflight', started_at: new Date(Date.now() - HOUR / 2), timeout_secs: 3600 },
        ],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult([]));
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(updateCalls()).toHaveLength(0);
    });

    it('rolls back the reap transaction on a mid-transaction failure and finishes the tick', async () => {
      // If any statement inside the reap transaction fails (here: the
      // webhook-delivery INSERT), the whole reap must roll back — the run
      // stays RUNNING for the next tick to retry — and the tick's scaling
      // work must still complete. A rethrow here would abort the tick and
      // skip the desired-count/scale decisions for no reason.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'ghost', started_at: new Date(Date.now() - 20 * HOUR), timeout_secs: 3600 },
        ],
        webhooks: [{ id: 'wh-1', actor_id: null, run_id: null }],
        rejectWebhookInserts: true,
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 0,
          runIds: [],
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.2,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await expect(initScaler()).resolves.toBeUndefined();

      const sqls = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(sqls).toContain('ROLLBACK');
      expect(sqls).not.toContain('COMMIT');
      // The tick completed past the failed reap: the end-of-tick runner
      // snapshot write is the last thing scalingLoop does.
      expect(redisSet).toHaveBeenCalledWith(
        'scaler:runners',
        expect.any(String),
        'EX',
        expect.any(Number)
      );
      errorSpy.mockRestore();
    });

    it('warns about RUNNING rows with null started_at instead of silently skipping them', async () => {
      // findZombieRuns skips ageless rows (cannot judge them), so without
      // the warning they would linger RUNNING forever with zero trace.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [{ id: 'no-start', started_at: null }],
      });
      noopList.mockResolvedValue([]);
      redisScan.mockResolvedValue(scanResult([]));
      redisGet.mockResolvedValue(String(Date.now() - 60_000));

      await initScaler();

      expect(updateCalls()).toHaveLength(0); // surfaced, not reaped
      expect(
        warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('no-start'))
      ).toBe(true);
      warnSpy.mockRestore();
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

    it('does NOT refresh LAST_ACTIVITY for zombie RUNNING rows with no live runner (regression: scale-down freeze)', async () => {
      // Pre-v0.9.9 the gate was `stats.total > 0`, which let RUNNING
      // rows whose owning runner had died — and therefore could never
      // issue the terminal UPDATE — keep refreshing LAST_ACTIVITY every
      // tick. That kept idleMs near zero forever and blocked scale-down
      // in scalingLoop, pinning the cluster at high-water for 5+ hours
      // in the live production repro.
      //
      // The fix gates on heartbeats: a RUNNING row "counts" only if a
      // live runner reports activeRuns > 0. Zombie rows whose runners
      // are gone (no matching heartbeat) do not refresh activity, so
      // idleMs builds and the existing idle-timeout gate eventually
      // releases the scale-down.
      queryMock.mockResolvedValue(dbRows({ ready: 0, running: 2 })); // 2 zombies
      noopList.mockResolvedValue([]); // no live runners at all
      redisScan.mockResolvedValue(scanResult([])); // no heartbeats

      await initScaler();

      const activityCall = redisSet.mock.calls.find((c) => c[0] === 'scaler:last-activity');
      expect(activityCall).toBeUndefined();
    });

    it('refreshes LAST_ACTIVITY when a live runner claims the RUNNING row via heartbeat (no false-idle)', async () => {
      // Counterpoint to the zombie case: a live runner with real work in
      // progress must refresh activity even if `ready` is zero, otherwise
      // long-running jobs would be falsely flagged idle and capacity
      // yanked from under them. Validated via the runId-claim path.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [{ id: 'rX', started_at: new Date(Date.now() - 60_000) }],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 1,
          runIds: ['rX'],
          healthy: true,
          cpuUsage: 0.3,
          memoryUsageRatio: 0.5,
        }),
      ]);

      await initScaler();

      const activityCall = redisSet.mock.calls.find((c) => c[0] === 'scaler:last-activity');
      expect(activityCall).toBeDefined();
    });

    it('refreshes LAST_ACTIVITY during pickup race (RUNNING row fresh, heartbeat lag has not landed yet) — Codex #52 P1 regression', async () => {
      // The race window: a runner picks up a READY row via Redis pub/sub
      // (sub-second), the DB flips to RUNNING immediately, but the
      // runner's most recent heartbeat (up to ~30s stale) still reports
      // `activeRuns: 0` and an empty `runIds`. In that window the
      // heartbeat-claim path is empty.
      //
      // Without the started_at fallback the scaler would treat the just-
      // busy runner as idle, and if `idleMs > idleTimeoutSecs` would
      // destroy it mid-pickup. The PICKUP_GRACE_MS window (3× heartbeat
      // interval = 90s) keeps activity refreshed until the next heartbeat
      // resolves the race.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [{ id: 'rRace', started_at: new Date(Date.now() - 5_000) }],
      });
      noopList.mockResolvedValue([makeRunner('r1')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:r1']));
      // Heartbeat is stale relative to the pickup — empty runIds, activeRuns=0
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'r1',
          activeRuns: 0,
          runIds: [],
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.3,
        }),
      ]);
      redisGet.mockResolvedValue(String(Date.now() - 3_600_000)); // idle timer would otherwise allow destroy

      await initScaler();

      const activityCall = redisSet.mock.calls.find((c) => c[0] === 'scaler:last-activity');
      expect(activityCall).toBeDefined();
      // And critically: the just-busy runner must NOT have been destroyed
      // by the idle gate while the race was still in the grace window.
      expect(noopDestroy).not.toHaveBeenCalled();
    });

    it('does NOT refresh LAST_ACTIVITY for a RUNNING row older than PICKUP_GRACE_MS with no live claim (zombie)', async () => {
      // Closes the loop on Codex P1: the grace window must NOT extend
      // protection indefinitely. A row that started long ago AND no live
      // runner claims it is a zombie — drain.
      setupQueryMock({
        stats: { ready: 0, running: 1 },
        runningRows: [
          { id: 'zombie', started_at: new Date(Date.now() - 10 * 60_000) }, // 10min old
        ],
      });
      noopList.mockResolvedValue([makeRunner('idleR')]);
      redisScan.mockResolvedValue(scanResult(['runner:heartbeat:idleR']));
      redisMget.mockResolvedValue([
        JSON.stringify({
          runnerId: 'idleR',
          activeRuns: 0,
          runIds: [], // does NOT claim the zombie row
          healthy: true,
          cpuUsage: 0.1,
          memoryUsageRatio: 0.3,
        }),
      ]);

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
        result: await work({ query: queryMock } as never),
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
