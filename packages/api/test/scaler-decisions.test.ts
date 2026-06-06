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
      const desired = calculateDesiredRunners(
        { ready: NaN, running: -3, total: NaN },
        5,
        cfg
      );
      expect(desired).toBe(1); // totalDemand coerces to 0 → returns minRunners
      expect(Number.isFinite(desired)).toBe(true);
    });
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
      countLiveRunning(
        [{ id: 'r1', started_at: new Date(now - 60_000) }],
        new Set(['r1']),
        now
      )
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
