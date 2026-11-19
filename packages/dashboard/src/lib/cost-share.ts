/**
 * A copyable, self-contained summary of a run's cost comparison.
 *
 * It is pasted outside the dashboard, so it carries its own caveats: how
 * each figure was derived and what each side leaves out. It never states a
 * savings percentage — the reader can do that arithmetic with the caveats
 * in front of them.
 */
import type { RunCost } from './api';

/** $1,234.56 above a cent; 4 decimals below so tiny run costs stay legible. */
export function money(v: number): string {
  if (v === 0) return '$0.00';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** Seconds under a minute, minutes under an hour, then hours — "0.00 h" tells nobody anything. */
function duration(hours: number): string {
  if (hours < 1 / 60) return `${Math.round(hours * 3600)} s`;
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(2)} h`;
}

/** Two decimals, or four when the run was too short for two to say much. */
function computeUnits(cu: number): string {
  return cu >= 0.1 ? cu.toFixed(2) : cu.toFixed(4);
}

/**
 * True when the run executed on a self-hosted runner whose price is unknown:
 * the default `local-docker` provider (a laptop, a paid VPS or a standalone
 * runner all report it) with no recorded runner price. Keyed on the price,
 * not the label alone: a standalone runner can record RUNNER_PRICE_HOURLY
 * under that label, and an API older than 1.7.0 sends a $0 cost (and a 100%
 * saving) for unpriced runs, which only the missing price gives away.
 */
export function isUnpricedRunner(
  runnerProvider: string | null,
  runnerPriceHourly: number | null
): boolean {
  return runnerProvider === 'local-docker' && runnerPriceHourly === null;
}

/**
 * Markdown summary, or null when a priced runner's cost was never recorded
 * (there is nothing honest to compare). A self-hosted run still gets one: it
 * says the runner price is unknown rather than claiming a figure.
 */
export function formatCostShare(cost: RunCost): string | null {
  const { inputs } = cost;
  const selfHosted = isUnpricedRunner(inputs.runnerProvider, inputs.runnerPriceHourly);
  if (!selfHosted && cost.yourCostUsd === null) return null;

  const apify = `~${money(cost.apifyCostUsd)} on Apify (estimate)`;
  const cu = computeUnits(inputs.computeUnits);
  const items = `${cost.itemCount.toLocaleString('en-US')} ${cost.itemCount === 1 ? 'item' : 'items'}`;

  const lines = [
    selfHosted
      ? `**Run cost: self-hosted, runner price not recorded vs ${apify}**`
      : `**Run cost: ${money(cost.yourCostUsd!)} self-hosted vs ${apify}**`,
    '',
    `- ${items}, ${duration(inputs.durationHours)}, ${cu} compute units`,
  ];
  if (!selfHosted && inputs.runnerPriceHourly !== null) {
    lines.push(
      `- Self-hosted: share of a $${inputs.runnerPriceHourly}/hr runner, split across overlapping runs`
    );
  }
  lines.push(
    `- Apify: ${cu} CU × $${inputs.apifyCuPrice}/CU; excludes proxy, storage and data transfer`,
    '- Idle runner time and ops hours are not counted on the self-hosted side'
  );
  return lines.join('\n');
}
