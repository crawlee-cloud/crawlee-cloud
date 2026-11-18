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
 * True when the run executed on a runner whose price is unknown.
 * `local-docker` is the runner's default provider — it is what a laptop, a
 * paid VPS and a standalone runner all report unless the autoscaler stamped
 * a price — so a cost of 0 here is an absence of data, never a saving.
 */
function isUnpricedRunner(cost: RunCost): boolean {
  return cost.inputs.runnerProvider === 'local-docker';
}

/** Whether a savings percentage is honest to show: only against a recorded runner price. */
export function showsSavings(cost: RunCost): boolean {
  return cost.savingsPct !== null && !isUnpricedRunner(cost);
}

/**
 * Markdown summary, or null when no infrastructure cost was recorded for
 * the run (there is nothing honest to compare).
 */
export function formatCostShare(cost: RunCost): string | null {
  if (cost.yourCostUsd === null) return null;

  const { inputs } = cost;
  const selfHosted = isUnpricedRunner(cost);
  const apify = `~${money(cost.apifyCostUsd)} on Apify (estimate)`;
  const cu = computeUnits(inputs.computeUnits);
  const items = `${cost.itemCount.toLocaleString('en-US')} ${cost.itemCount === 1 ? 'item' : 'items'}`;

  const lines = [
    selfHosted
      ? `**Run cost: self-hosted, runner price not recorded vs ${apify}**`
      : `**Run cost: ${money(cost.yourCostUsd)} self-hosted vs ${apify}**`,
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
