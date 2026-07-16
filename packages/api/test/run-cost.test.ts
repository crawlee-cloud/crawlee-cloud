/**
 * Actual-overlap cost attribution — pure timeline-slicing math.
 *
 * Model: a droplet bills $priceHourly regardless of how many runs it hosts.
 * A run's cost is the sum over each slice of its own window of
 * (priceHourly × sliceHours ÷ runsActiveInSlice).
 */

import { describe, it, expect } from 'vitest';
import { computeOverlapCost, type CostWindow } from '../src/lib/run-cost.js';

const T0 = new Date('2026-07-15T10:00:00Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const NOW = hours(100); // far future — irrelevant unless a sibling is running

describe('computeOverlapCost', () => {
  it('charges the full droplet rate when the run is alone', () => {
    // 2h alone at $0.10/hr → $0.20
    const cost = computeOverlapCost({ startedAt: T0, finishedAt: hours(2) }, [], 0.1, NOW);
    expect(cost).toBeCloseTo(0.2, 10);
  });

  it('splits evenly with one fully-overlapping sibling', () => {
    // 2h with one sibling covering the whole window → half of $0.20
    const siblings: CostWindow[] = [{ startedAt: T0, finishedAt: hours(2) }];
    const cost = computeOverlapCost({ startedAt: T0, finishedAt: hours(2) }, siblings, 0.1, NOW);
    expect(cost).toBeCloseTo(0.1, 10);
  });

  it('handles staggered partial overlaps', () => {
    // Run: 0h→3h. Sibling A: 1h→2h. Sibling B: 2h→4h.
    // Slices: [0,1) alone → 0.1; [1,2) with A → 0.05; [2,3) with B → 0.05.
    const siblings: CostWindow[] = [
      { startedAt: hours(1), finishedAt: hours(2) },
      { startedAt: hours(2), finishedAt: hours(4) },
    ];
    const cost = computeOverlapCost({ startedAt: T0, finishedAt: hours(3) }, siblings, 0.1, NOW);
    expect(cost).toBeCloseTo(0.2, 10);
  });

  it('treats a still-running sibling as ending at `now`', () => {
    // Run: 0h→2h. Sibling started at 1h, finishedAt null, now = 1.5h.
    // Slices: [0,1) alone → 0.1; [1,1.5) shared → 0.025; [1.5,2) alone → 0.05.
    const siblings: CostWindow[] = [{ startedAt: hours(1), finishedAt: null }];
    const cost = computeOverlapCost(
      { startedAt: T0, finishedAt: hours(2) },
      siblings,
      0.1,
      hours(1.5)
    );
    expect(cost).toBeCloseTo(0.175, 10);
  });

  it('counts three concurrent runs as a three-way split', () => {
    // 1h with two siblings covering the whole window → $0.10 / 3
    const siblings: CostWindow[] = [
      { startedAt: T0, finishedAt: hours(1) },
      { startedAt: T0, finishedAt: hours(1) },
    ];
    const cost = computeOverlapCost({ startedAt: T0, finishedAt: hours(1) }, siblings, 0.1, NOW);
    expect(cost).toBeCloseTo(0.1 / 3, 10);
  });

  it('returns 0 for a zero- or negative-duration window', () => {
    expect(computeOverlapCost({ startedAt: T0, finishedAt: T0 }, [], 0.1, NOW)).toBe(0);
    expect(computeOverlapCost({ startedAt: hours(1), finishedAt: T0 }, [], 0.1, NOW)).toBe(0);
  });

  it('ignores siblings entirely outside the window', () => {
    const siblings: CostWindow[] = [
      { startedAt: hours(-2), finishedAt: hours(0) }, // ends exactly at start
      { startedAt: hours(2), finishedAt: hours(3) }, // starts exactly at end
    ];
    const cost = computeOverlapCost({ startedAt: T0, finishedAt: hours(2) }, siblings, 0.1, NOW);
    expect(cost).toBeCloseTo(0.2, 10);
  });
});
