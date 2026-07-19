'use client';

import { useEffect, useState } from 'react';
import { DollarSign, Info } from 'lucide-react';
import { getRunCost, type Run, type RunCost } from '@/lib/api';

const TERMINAL = new Set<Run['status']>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

/** $1,234.56 above a cent; 4 decimals below so tiny run costs stay legible. */
function money(v: number): string {
  if (v === 0) return '$0.00';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/**
 * Self-fetching cost breakdown for a finished run: what it actually cost to
 * run here vs. an equivalent Apify run, plus the derived savings. Fetches
 * only once the run has reached a terminal status (Task 3's endpoint has
 * nothing to report before then) and quietly renders nothing on any error —
 * a cost hiccup must never break the run details page.
 */
export function CostAnalysisCard({ runId, status }: { runId: string; status: Run['status'] }) {
  const [cost, setCost] = useState<RunCost | null>(null);

  // Stale-data guard lives at the call site: the page keys this component
  // by runId, so navigating run A → run B remounts it with fresh null
  // state. Without that key, A's numbers would linger while B fetches —
  // permanently if B's fetch fails, since the catch below swallows errors
  // by design. (An in-effect setCost(null) reset is the alternative, but
  // synchronous setState in effects trips the cascading-render lint rule.)
  useEffect(() => {
    if (!TERMINAL.has(status)) return;
    let cancelled = false;
    getRunCost(runId)
      .then((c) => {
        if (!cancelled) setCost(c);
      })
      .catch(() => {
        // Best-effort decoration — a cost hiccup must never break run details.
      });
    return () => {
      cancelled = true;
    };
  }, [runId, status]);

  if (!TERMINAL.has(status) || !cost) return null;

  const selfHosted = cost.inputs.runnerProvider === 'local-docker';
  const recorded = cost.yourCostUsd !== null;
  const showPer1k = cost.itemCount > 0;

  return (
    <section className="panel p-5">
      <p className="eyebrow flex items-center gap-1.5 mb-4">
        <DollarSign className="h-3 w-3" /> COST · ANALYSIS
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div>
          <p className="eyebrow mb-1">Items scraped</p>
          <p className="text-[13px] text-foreground tnum">{cost.itemCount.toLocaleString()}</p>
        </div>

        <div>
          <p className="eyebrow mb-1">Your cost</p>
          <p className="text-[13px] text-foreground tnum">
            {recorded ? money(cost.yourCostUsd!) : 'Not recorded'}
            {selfHosted && ' (self-hosted)'}
          </p>
          {recorded && showPer1k && cost.yourCostPer1kItems !== null && (
            <p className="text-[11px] text-muted-foreground tnum">
              {money(cost.yourCostPer1kItems)} / 1k items
            </p>
          )}
        </div>

        <div>
          <p className="eyebrow mb-1">Same run on Apify</p>
          <p className="text-[13px] text-foreground tnum">{money(cost.apifyCostUsd)}</p>
          {showPer1k && cost.apifyCostPer1kItems !== null && (
            <p className="text-[11px] text-muted-foreground tnum">
              {money(cost.apifyCostPer1kItems)} / 1k items
            </p>
          )}
        </div>

        {cost.savingsPct !== null && (
          <div>
            <p className="eyebrow mb-1">You saved</p>
            <p className="text-[13px] font-medium text-ok tnum">
              {selfHosted ? '100% (self-hosted)' : `${cost.savingsPct}%`}
            </p>
          </div>
        )}
      </div>

      <p className="mt-4 pt-4 border-t border-border flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          {recorded && !selfHosted && cost.inputs.runnerPriceHourly !== null
            ? `Shared a $${cost.inputs.runnerPriceHourly}/hr droplet with ${cost.inputs.overlappingRuns} other run${cost.inputs.overlappingRuns === 1 ? '' : 's'}. Idle droplet time is not attributed to runs. `
            : recorded
              ? 'Ran on your own machine — no droplet cost. '
              : 'Infrastructure cost was not recorded for this run. '}
          Apify estimate at ${cost.inputs.apifyCuPrice}/CU ({cost.inputs.computeUnits.toFixed(2)}{' '}
          compute units).
        </span>
      </p>
    </section>
  );
}
