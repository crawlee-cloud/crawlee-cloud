/**
 * Unit tests for the scaler's decision math.
 *
 * `calculateDesiredRunners` is the pure function at the heart of every
 * scale-up / scale-down decision. Bugs here translate directly to either
 * (a) over-provisioning runners (paying for VMs you don't need) or
 * (b) under-provisioning (queue pile-up, slow runs).
 *
 * The function has three regimes:
 *   - No demand → minRunners (the floor)
 *   - Low demand below threshold → stay flat (hysteresis, prevents flapping)
 *   - Real demand → ceil(demand / runsPerRunner), clamped to [min, max]
 */

import { describe, it, expect } from 'vitest';
import {
  calculateDesiredRunners,
  countLiveRunning,
  evaluateDeadCandidates,
  findZombieRuns,
  PICKUP_GRACE_MS,
  type QueueStats,
} from '../src/scaler/index.js';
import type { ScalerConfig } from '../src/scaler/types.js';

function makeConfig(overrides: Partial<ScalerConfig> = {}): ScalerConfig {
  return {
    enabled: true,
    provider: 'noop',
    minRunners: 1,
    maxRunners: 10,
    scaleUpThreshold: 5,
    idleTimeoutSecs: 600,
    pollIntervalSecs: 30,
    runsPerRunner: 2,
    runnerSize: 'unused',
    runnerRegion: 'unused',
    sshKeyId: 'unused',
    providerConfig: {},
    ...overrides,
  };
}

function stats(ready: number, running: number): QueueStats {
  return { ready, running, total: ready + running };
}

describe('calculateDesiredRunners', () => {
  describe('idle queue', () => {
    it('returns minRunners=0 when scale-to-zero is configured and queue is empty', () => {
      const desired = calculateDesiredRunners(stats(0, 0), 3, makeConfig({ minRunners: 0 }));
      expect(desired).toBe(0);
    });

    it('returns minRunners=1 when floor is 1 and queue is empty', () => {
      const desired = calculateDesiredRunners(stats(0, 0), 3, makeConfig({ minRunners: 1 }));
      expect(desired).toBe(1);
    });

    it('floor-protects even when current count is below min', () => {
      // Edge case: somehow we have 0 runners but min is 2 — must come back up
      const desired = calculateDesiredRunners(stats(0, 0), 0, makeConfig({ minRunners: 2 }));
      expect(desired).toBe(2);
    });
  });

  describe('hysteresis (low pressure)', () => {
    it('stays flat when ready <= threshold AND already at-or-above min', () => {
      // ready=3, threshold=5 → don't scale up just because there's some work
      const cfg = makeConfig({ scaleUpThreshold: 5, minRunners: 1 });
      const desired = calculateDesiredRunners(stats(3, 0), 1, cfg);
      expect(desired).toBe(1); // unchanged
    });

    it('does NOT block scale-up when below min, even if ready <= threshold', () => {
      // We have 0 runners, min is 2, ready is 1 (below threshold).
      // The min-floor must win — otherwise a brand-new system with min=2 would
      // never spawn its first runner because demand starts low.
      const cfg = makeConfig({ scaleUpThreshold: 5, minRunners: 2 });
      const desired = calculateDesiredRunners(stats(1, 0), 0, cfg);
      expect(desired).toBe(2);
    });

    it('scales up immediately once ready > threshold', () => {
      // 6 ready > threshold of 5 → math kicks in: ceil(6/2)=3
      const cfg = makeConfig({
        scaleUpThreshold: 5,
        runsPerRunner: 2,
        minRunners: 1,
        maxRunners: 10,
      });
      const desired = calculateDesiredRunners(stats(6, 0), 1, cfg);
      expect(desired).toBe(3);
    });
  });

  describe('scale-up math', () => {
    it('computes ceil(demand / runsPerRunner)', () => {
      const cfg = makeConfig({
        runsPerRunner: 3,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 100,
      });
      // 10 ready / 3 per runner = 3.33 → 4 runners
      expect(calculateDesiredRunners(stats(10, 0), 0, cfg)).toBe(4);
      // 9 / 3 = 3 exactly → 3 runners (no extra)
      expect(calculateDesiredRunners(stats(9, 0), 0, cfg)).toBe(3);
      // 1 / 3 = 0.33 → 1 runner (always round up)
      expect(calculateDesiredRunners(stats(1, 0), 0, cfg)).toBe(1);
    });

    it('counts RUNNING toward demand, not just READY', () => {
      // If we only counted READY, an in-flight run would let the scaler
      // tear down the runner that's currently executing it.
      const cfg = makeConfig({
        runsPerRunner: 1,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 10,
      });
      expect(calculateDesiredRunners(stats(0, 5), 5, cfg)).toBe(5);
    });

    it('clamps to maxRunners even under huge demand', () => {
      const cfg = makeConfig({
        runsPerRunner: 1,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 5,
      });
      expect(calculateDesiredRunners(stats(1000, 0), 0, cfg)).toBe(5);
    });
  });

  describe('scale-down math', () => {
    it('asks for fewer runners when demand drops below current capacity', () => {
      // Yesterday: 20 ready → 10 runners. Today: only 4 ready left.
      // ceil(4/2) = 2 → desired = 2, current = 10 → caller will scale down by 8.
      const cfg = makeConfig({
        runsPerRunner: 2,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 20,
      });
      expect(calculateDesiredRunners(stats(4, 0), 10, cfg)).toBe(2);
    });

    it('returns to the floor when the queue fully drains', () => {
      // This is the "all runs done" path that triggers eventual scale-down.
      const cfg = makeConfig({ minRunners: 1, maxRunners: 10 });
      expect(calculateDesiredRunners(stats(0, 0), 5, cfg)).toBe(1);
    });

    it('never returns below minRunners no matter how empty', () => {
      const cfg = makeConfig({ minRunners: 3 });
      expect(calculateDesiredRunners(stats(0, 0), 10, cfg)).toBe(3);
    });
  });

  describe('scale-down through the threshold (regression: zombie-tail freeze)', () => {
    // The pre-v0.9.9 code returned `currentRunners` whenever
    // `ready <= scaleUpThreshold`, regardless of direction. The intent
    // was hysteresis (don't scale UP on a trickle), but the unconditional
    // return also suppressed scale-DOWN — so once a burst lifted the
    // count, a long-running tail (running > 0, ready == 0) kept
    // totalDemand > 0 and pinned the cluster at high-water.
    //
    // Live production repro 2026-06-05: desired=10 for 5+ hours with
    // ready=0, running=2 (two zombie RUNNING rows whose owning droplet
    // had been reaped without their lifecycle being closed out).
    //
    // The fix preserves the freeze-UP semantics but releases the
    // freeze-DOWN. These tests lock in both halves of that asymmetry.

    it('drains the zombie tail: ready=0 + RUNNING>0 below threshold scales DOWN', () => {
      // The exact production repro state. ceil(2/5)=1, clamped to min=1.
      const cfg = makeConfig({
        runsPerRunner: 5,
        scaleUpThreshold: 5,
        minRunners: 1,
        maxRunners: 10,
      });
      expect(calculateDesiredRunners(stats(0, 2), 10, cfg)).toBe(1);
    });

    it('scales DOWN through the threshold when current exceeds need', () => {
      // ready=3 ≤ threshold=5, but current=10 is way above needed=2.
      // Pre-fix: returned 10 (frozen). Post-fix: returns 2 (scale down).
      const cfg = makeConfig({
        runsPerRunner: 2,
        scaleUpThreshold: 5,
        minRunners: 1,
        maxRunners: 20,
      });
      expect(calculateDesiredRunners(stats(3, 0), 10, cfg)).toBe(2);
    });

    it('freezes UP at threshold-equal demand (hysteresis on the up direction only)', () => {
      // ready=5 exactly equals threshold=5; current is already enough.
      // Math says ceil(5/2)=3 > current=2, so we WOULD scale up — but
      // hysteresis suppresses it until ready *exceeds* threshold.
      const cfg = makeConfig({
        runsPerRunner: 2,
        scaleUpThreshold: 5,
        minRunners: 1,
      });
      expect(calculateDesiredRunners(stats(5, 0), 2, cfg)).toBe(2);
    });

    it('still scales up to the floor even when ready ≤ threshold (cold start)', () => {
      // This is the L73 case re-asserted post-fix. A naive Shape A that
      // drops the `current >= minRunners` clause would regress this —
      // see the floor-rule clause in calculateDesiredRunners.
      const cfg = makeConfig({
        runsPerRunner: 2,
        scaleUpThreshold: 5,
        minRunners: 2,
      });
      expect(calculateDesiredRunners(stats(1, 0), 0, cfg)).toBe(2);
    });

    it('coerces NaN/negative inputs to 0 rather than NaN-propagating', () => {
      // Defensive: parseInt of a malformed COUNT(*) row could yield NaN,
      // and a future query refactor could pass negatives. The function
      // must never return NaN or a negative — both would corrupt the
      // scaleUp/scaleDown arithmetic in scalingLoop.
      const cfg = makeConfig({ minRunners: 1 });
      const desired = calculateDesiredRunners({ ready: NaN, running: -3, total: NaN }, 5, cfg);
      expect(desired).toBe(1); // totalDemand coerces to 0 → returns minRunners
      expect(Number.isFinite(desired)).toBe(true);
    });
  });
});

describe('zombie-aware demand (liveRunningCount)', () => {
  // Live production incident 2026-07-13: 12 zombie RUNNING rows (owning
  // runners long dead) kept totalDemand at 25 while real work was 13 runs.
  // The scaler spawned and held 10 droplets — desired=ceil(25/3)=9 — even
  // though the activity gate correctly ignored the zombies. Demand and
  // activity disagreed because only the activity gate used
  // countLiveRunning. These tests pin demand to the same source of truth.

  it('excludes unclaimed RUNNING rows from demand when liveRunningCount is provided', () => {
    // 12 zombies, 0 ready, 0 live claims → no real demand → floor.
    const cfg = makeConfig({
      runsPerRunner: 3,
      scaleUpThreshold: 5,
      minRunners: 0,
      maxRunners: 10,
    });
    expect(calculateDesiredRunners(stats(0, 12), 10, cfg, 0)).toBe(0);
  });

  it('still counts live-claimed RUNNING rows toward demand', () => {
    // 12 RUNNING in the DB but only 6 have live owners → ceil(6/3)=2.
    const cfg = makeConfig({
      runsPerRunner: 3,
      scaleUpThreshold: 0,
      minRunners: 0,
      maxRunners: 10,
    });
    expect(calculateDesiredRunners(stats(0, 12), 10, cfg, 6)).toBe(2);
  });

  it('falls back to stats.running when liveRunningCount is omitted (back-compat)', () => {
    const cfg = makeConfig({
      runsPerRunner: 1,
      scaleUpThreshold: 0,
      minRunners: 0,
      maxRunners: 10,
    });
    expect(calculateDesiredRunners(stats(0, 5), 5, cfg)).toBe(5);
  });

  it('coerces NaN/negative liveRunningCount to 0', () => {
    const cfg = makeConfig({ minRunners: 1 });
    expect(calculateDesiredRunners(stats(0, 5), 5, cfg, NaN)).toBe(1);
    expect(calculateDesiredRunners(stats(0, 5), 5, cfg, -2)).toBe(1);
  });
});

describe('evaluateDeadCandidates (consecutive-miss dead detection)', () => {
  // Live production incident 2026-07-09..12: the pre-v1.0.2 code marked a
  // runner 'dead' — and hard-destroyed the droplet — on a SINGLE tick where
  // its heartbeat key was missing, as long as the droplet was >3min old.
  // Runner heartbeats have a 90s TTL in Redis; one managed-Redis failover
  // or restart wipes every heartbeat at once, and the very next tick
  // destroyed the whole busy fleet. Each destroyed runner's claimed runs
  // (runsPerRunner per droplet) became immortal zombie RUNNING rows —
  // observed as four batches of exactly 3 runs, always at night (managed
  // DB maintenance windows).
  //
  // Condemnation requires BOTH `missThreshold` consecutive misses AND
  // `missWindowMs` of wall-clock time since the FIRST miss. Ticks alone
  // are not enough: the advisory lock is a per-tick try-lock, so N API
  // replicas with offset timers can interleave N ticks per poll interval
  // — 3 misses can accumulate in seconds, which would re-open the single-
  // blip massacre through the counter itself.
  const now = Date.now();
  const opts = { deadAfterMs: 180_000, missThreshold: 3, missWindowMs: 90_000, now };
  const oldRunner = (id: string) => ({ id, createdAt: new Date(now - 3_600_000) });

  it('never condemns a runner that has a heartbeat, and clears its miss counter', () => {
    const { deadIds, nextMisses } = evaluateDeadCandidates(
      [oldRunner('r1')],
      new Set(['r1']),
      { r1: { c: 2, t: now - 120_000 } }, // was one miss away from death — heartbeat came back
      opts
    );
    expect(deadIds.size).toBe(0);
    expect(nextMisses.r1).toBeUndefined();
  });

  it('does not accrue misses for a still-booting runner (age <= deadAfterMs)', () => {
    const booting = { id: 'b1', createdAt: new Date(now - 60_000) }; // 1min old
    const { deadIds, nextMisses } = evaluateDeadCandidates([booting], new Set(), {}, opts);
    expect(deadIds.size).toBe(0);
    expect(nextMisses.b1).toBeUndefined();
  });

  it('accrues a miss but does NOT condemn before the threshold, preserving firstMissAt', () => {
    // Tick 1 and 2 of a Redis blip: counter rises, nobody dies. The
    // first-miss timestamp is set on tick 1 and must survive tick 2 —
    // it anchors the wall-clock window.
    const first = evaluateDeadCandidates([oldRunner('r1')], new Set(), {}, opts);
    expect(first.deadIds.size).toBe(0);
    expect(first.nextMisses.r1).toEqual({ c: 1, t: now });

    const second = evaluateDeadCandidates([oldRunner('r1')], new Set(), first.nextMisses, {
      ...opts,
      now: now + 30_000,
    });
    expect(second.deadIds.size).toBe(0);
    expect(second.nextMisses.r1).toEqual({ c: 2, t: now });
  });

  it('condemns once misses reach the threshold AND the miss window has elapsed', () => {
    const { deadIds, nextMisses } = evaluateDeadCandidates(
      [oldRunner('r1')],
      new Set(),
      { r1: { c: 2, t: now - 120_000 } }, // two prior misses, first one 2min ago
      opts
    );
    expect(deadIds.has('r1')).toBe(true);
    expect(nextMisses.r1).toEqual({ c: 3, t: now - 120_000 });
  });

  it('does NOT condemn on threshold misses accumulated within seconds (interleaved replica ticks)', () => {
    // Multi-replica exposure: with offset timers, 3 ticks can land in
    // ~20s. Count says condemn, but the runner never had a full
    // heartbeat-TTL window to get a beat through — must survive.
    const { deadIds, nextMisses } = evaluateDeadCandidates(
      [oldRunner('r1')],
      new Set(),
      { r1: { c: 2, t: now - 5_000 } }, // first miss only 5s ago
      opts
    );
    expect(deadIds.size).toBe(0);
    expect(nextMisses.r1).toEqual({ c: 3, t: now - 5_000 });
  });

  it('tolerates legacy plain-number miss entries without instantly condemning', () => {
    // Pre-window deploys persisted `{ runnerId: count }` in Redis. Reading
    // one must not crash, and must restart the clock (conservative: the
    // legacy shape has no firstMissAt, so the window starts now).
    const { deadIds, nextMisses } = evaluateDeadCandidates(
      [oldRunner('r1')],
      new Set(),
      { r1: 2 }, // legacy shape from a pre-upgrade scaler
      opts
    );
    expect(deadIds.size).toBe(0); // count hits 3, but window restarted at `now`
    expect(nextMisses.r1).toEqual({ c: 3, t: now });
  });

  it('survives the incident scenario: fleet-wide heartbeat wipe followed by recovery', () => {
    // Redis failover wipes all heartbeats for one tick; keys are
    // re-published within 30s (next runner beat). Ticks 1-2 miss, tick 3
    // heartbeats are back. Nobody must die.
    const fleet = [oldRunner('a'), oldRunner('b'), oldRunner('c')];
    const t1 = evaluateDeadCandidates(fleet, new Set(), {}, opts);
    const t2 = evaluateDeadCandidates(fleet, new Set(), t1.nextMisses, opts);
    expect(t1.deadIds.size + t2.deadIds.size).toBe(0);
    const t3 = evaluateDeadCandidates(fleet, new Set(['a', 'b', 'c']), t2.nextMisses, opts);
    expect(t3.deadIds.size).toBe(0);
    expect(Object.keys(t3.nextMisses)).toHaveLength(0); // all counters reset
  });

  it('prunes counters for runners that no longer exist', () => {
    const { nextMisses } = evaluateDeadCandidates(
      [oldRunner('alive')],
      new Set(['alive']),
      { ghost: { c: 2, t: now - 120_000 } }, // destroyed last tick — counter must not leak
      opts
    );
    expect(nextMisses.ghost).toBeUndefined();
  });
});

describe('countLiveRunning (runId+started_at correlation)', () => {
  // The pure function behind the activity gate. Distinguishes real
  // work (RUNNING row claimed by a live heartbeat, or freshly picked
  // up and still inside the heartbeat-lag grace window) from zombies
  // (RUNNING rows old enough that the next heartbeat should already
  // have claimed them, but didn't).
  //
  // Without this correlation, v0.9.9's first fix attempt regressed a
  // race window during pickup-vs-heartbeat (Codex #52 P1): a runner
  // picks up a READY row via pub/sub in < 1s, the DB shows RUNNING
  // immediately, but the most-recent heartbeat (up to 30s old) still
  // reports activeRuns=0 / runIds=[]. The activity gate would then
  // false-idle and destroy the just-busy runner.
  const now = Date.now();

  it('counts a RUNNING row claimed by a heartbeat as live work', () => {
    expect(
      countLiveRunning([{ id: 'r1', started_at: new Date(now - 60_000) }], new Set(['r1']), now)
    ).toBe(1);
  });

  it('counts a fresh pickup (no claim yet, started_at within PICKUP_GRACE_MS) as live work', () => {
    // The Codex P1 scenario — pickup happened seconds ago, heartbeat
    // simply hasn't landed yet. Give one tick of grace.
    expect(
      countLiveRunning(
        [{ id: 'fresh', started_at: new Date(now - 5_000) }],
        new Set(), // no heartbeat claims it
        now
      )
    ).toBe(1);
  });

  it('does NOT count a stale RUNNING row (started_at older than grace, no claim) — zombie', () => {
    // The freeze case. After PICKUP_GRACE_MS the runner should have
    // heartbeated at least once with the runId; if it hasn't, the
    // owning runner is gone.
    expect(
      countLiveRunning(
        [{ id: 'zombie', started_at: new Date(now - PICKUP_GRACE_MS - 1) }],
        new Set(),
        now
      )
    ).toBe(0);
  });

  it('does NOT count a RUNNING row with null started_at and no claim', () => {
    // Defensive: started_at should always be set when status='RUNNING'
    // (runner sets both atomically — packages/runner/src/queue.ts:226).
    // But if it isn't, refusing to count is the conservative choice.
    expect(countLiveRunning([{ id: 'r', started_at: null }], new Set(), now)).toBe(0);
  });

  it('mixed: some claimed, some fresh, some zombie', () => {
    expect(
      countLiveRunning(
        [
          { id: 'claimed', started_at: new Date(now - 30 * 60_000) }, // 30min old but claimed → live
          { id: 'fresh', started_at: new Date(now - 1_000) }, // 1s old → grace
          { id: 'zombie', started_at: new Date(now - 5 * 60 * 60_000) }, // 5h old, no claim → zombie
        ],
        new Set(['claimed']),
        now
      )
    ).toBe(2);
  });

  it('returns 0 for an empty input', () => {
    expect(countLiveRunning([], new Set(), now)).toBe(0);
  });
});

describe('findZombieRuns (API-side zombie-run reaper)', () => {
  const now = 1_750_000_000_000;
  const HOUR = 3_600_000;

  it('flags an unclaimed RUNNING row past its timeout + grace', () => {
    const rows = [{ id: 'z1', started_at: new Date(now - 2 * HOUR), timeout_secs: 3600 }];
    expect(findZombieRuns(rows, new Set(), now)).toEqual(['z1']);
  });

  it('never flags a run claimed by a live heartbeat, even far past timeout', () => {
    // Timeout enforcement for OWNED runs belongs to the owning runner
    // (docker stop → exit 143 → TIMED-OUT). The API reaper only covers
    // runs whose owner is gone; double-enforcement would race the runner's
    // terminal UPDATE.
    const rows = [{ id: 'owned', started_at: new Date(now - 20 * HOUR), timeout_secs: 3600 }];
    expect(findZombieRuns(rows, new Set(['owned']), now)).toEqual([]);
  });

  it('does NOT flag an unclaimed run still within its timeout window', () => {
    // Unclaimed-but-in-window = possibly a heartbeat blip; the run may
    // finish normally. Only reap once even a healthy owner would have
    // timed it out.
    const rows = [{ id: 'r1', started_at: new Date(now - HOUR / 2), timeout_secs: 3600 }];
    expect(findZombieRuns(rows, new Set(), now)).toEqual([]);
  });

  it('respects the grace window just past the timeout boundary', () => {
    const rows = [
      {
        id: 'boundary',
        started_at: new Date(now - HOUR - PICKUP_GRACE_MS + 1),
        timeout_secs: 3600,
      },
    ];
    expect(findZombieRuns(rows, new Set(), now)).toEqual([]);
  });

  it('falls back to 3600s when timeout_secs is null', () => {
    const rows = [{ id: 'nt', started_at: new Date(now - 2 * HOUR), timeout_secs: null }];
    expect(findZombieRuns(rows, new Set(), now)).toEqual(['nt']);
  });

  it('skips rows with null started_at (cannot judge age)', () => {
    const rows = [{ id: 'ns', started_at: null, timeout_secs: 3600 }];
    expect(findZombieRuns(rows, new Set(), now)).toEqual([]);
  });

  it('returns only the zombies from a mixed set', () => {
    const rows = [
      { id: 'owned', started_at: new Date(now - 20 * HOUR), timeout_secs: 3600 },
      { id: 'fresh', started_at: new Date(now - 1_000), timeout_secs: 3600 },
      { id: 'zombie', started_at: new Date(now - 20 * HOUR), timeout_secs: 3600 },
    ];
    expect(findZombieRuns(rows, new Set(['owned']), now)).toEqual(['zombie']);
  });
});
