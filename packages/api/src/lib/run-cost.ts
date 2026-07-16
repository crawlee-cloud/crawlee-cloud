/**
 * Actual-overlap cost attribution for runs sharing a droplet.
 *
 * A droplet bills a flat $/hr regardless of how many containers it hosts,
 * so a per-run cost is an allocation: slice the run's own window at every
 * point where droplet concurrency changes, and charge each slice
 * priceHourly × sliceHours ÷ runsActiveInSlice. Summed across all runs on
 * a droplet this reconciles with the real DO bill (minus idle time, which
 * belongs to no run).
 *
 * Pure and side-effect free — `now` is a parameter (still-running siblings
 * have finishedAt = null) so tests never touch the clock.
 */

export interface CostWindow {
  startedAt: Date;
  finishedAt: Date | null;
}

export function computeOverlapCost(
  run: { startedAt: Date; finishedAt: Date },
  siblings: CostWindow[],
  priceHourly: number,
  now: Date
): number {
  const start = run.startedAt.getTime();
  const end = run.finishedAt.getTime();
  if (end <= start) return 0;

  const sibSpans = siblings.map((s) => ({
    start: s.startedAt.getTime(),
    end: (s.finishedAt ?? now).getTime(),
  }));

  // Slice boundaries: the window edges plus every sibling start/end that
  // falls strictly inside the window.
  const bounds = new Set<number>([start, end]);
  for (const s of sibSpans) {
    if (s.start > start && s.start < end) bounds.add(s.start);
    if (s.end > start && s.end < end) bounds.add(s.end);
  }
  const sorted = [...bounds].sort((a, b) => a - b);

  let cost = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    // The ?? 0 fallbacks are unreachable (i is bounded by length - 1) but
    // satisfy noUncheckedIndexedAccess without a non-null assertion.
    const sliceStart = sorted[i] ?? 0;
    const sliceEnd = sorted[i + 1] ?? 0;
    // Concurrency is constant within a slice by construction — sample the
    // midpoint. Half-open [start, end) semantics: a sibling that ends
    // exactly at the midpoint boundary is handled by strict comparison.
    const mid = (sliceStart + sliceEnd) / 2;
    let active = 1; // this run
    for (const s of sibSpans) {
      if (s.start < mid && s.end > mid) active++;
    }
    cost += (priceHourly * (sliceEnd - sliceStart)) / 3_600_000 / active;
  }
  return cost;
}
