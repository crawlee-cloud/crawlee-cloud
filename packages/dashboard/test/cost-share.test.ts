/**
 * Tests for the copyable cost summary on the run details page.
 *
 * The summary leaves the dashboard and gets pasted into issues, chats and
 * posts, so it has to stand on its own: both figures, how each was derived,
 * and what each side leaves out. The case that must never ship is a
 * local-Docker run reading as "100% cheaper" — no runner price was recorded
 * there, so there is no saving to claim.
 */
import { describe, expect, it } from 'vitest';
import { formatCostShare, isUnpricedRunner, money } from '@/lib/cost-share';
import type { RunCost } from '@/lib/api';

const base: RunCost = {
  yourCostUsd: 0.0412,
  apifyCostUsd: 0.3,
  savingsPct: 86.3,
  itemCount: 1200,
  yourCostPer1kItems: 0.034333,
  apifyCostPer1kItems: 0.25,
  inputs: {
    runnerProvider: 'digitalocean',
    runnerPriceHourly: 0.036,
    overlappingRuns: 2,
    apifyCuPrice: 0.2,
    computeUnits: 1.5,
    durationHours: 1.5,
  },
};

describe('money', () => {
  it('formats zero, sub-cent and cent-or-more amounts as the cost card does', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(0.0041)).toBe('$0.0041');
    expect(money(0.0412)).toBe('$0.04');
    expect(money(12.5)).toBe('$12.50');
  });
});

describe('formatCostShare', () => {
  it('returns null when the cost was never recorded on a priced runner', () => {
    expect(formatCostShare({ ...base, yourCostUsd: null, savingsPct: null })).toBeNull();
  });

  it('states both numbers, the item count and the assumptions', () => {
    expect(formatCostShare(base)).toBe(
      [
        '**Run cost: $0.04 self-hosted vs ~$0.30 on Apify (estimate)**',
        '',
        '- 1,200 items, 1.50 h, 1.50 compute units',
        '- Self-hosted: share of a $0.036/hr runner, split across overlapping runs',
        '- Apify: 1.50 CU × $0.2/CU; excludes proxy, storage and data transfer',
        '- Idle runner time and ops hours are not counted on the self-hosted side',
      ].join('\n')
    );
  });

  it('keeps four decimals for sub-cent costs, as the card does', () => {
    expect(formatCostShare({ ...base, yourCostUsd: 0.0041 })).toContain('$0.0041 self-hosted');
  });

  it('does not claim savings for a local-Docker run with no attributed cost', () => {
    // The API reports a local-Docker run's cost as unknown (null), not $0.
    const out = formatCostShare({
      ...base,
      yourCostUsd: null,
      savingsPct: null,
      yourCostPer1kItems: null,
      inputs: { ...base.inputs, runnerProvider: 'local-docker', runnerPriceHourly: null },
    });
    // 'local-docker' is the runner's DEFAULT provider, so this is also what a
    // paid VPS or standalone runner reports. Say what is known — no price was
    // recorded — not that the machine was free.
    expect(out).toContain('self-hosted, runner price not recorded vs ~$0.30 on Apify');
    expect(out).not.toContain('no droplet cost');
    expect(out).not.toContain('$0.00 self-hosted');
    expect(out).not.toContain('100%');
    expect(out).not.toContain('- Self-hosted:');
  });

  it('reports the real figure for a local-docker runner that recorded a price', () => {
    const out = formatCostShare({
      ...base,
      inputs: { ...base.inputs, runnerProvider: 'local-docker', runnerPriceHourly: 0.036 },
    });
    expect(out).toContain('**Run cost: $0.04 self-hosted vs ~$0.30 on Apify (estimate)**');
    expect(out).toContain('- Self-hosted: share of a $0.036/hr runner');
  });

  // An API older than 1.7.0 still sends $0 and savingsPct 100 for these runs.
  it('says "price not recorded" for an unpriced runner even when an older API sent $0', () => {
    const out = formatCostShare({
      ...base,
      yourCostUsd: 0,
      savingsPct: 100,
      inputs: { ...base.inputs, runnerProvider: 'local-docker', runnerPriceHourly: null },
    });
    expect(out).toContain('self-hosted, runner price not recorded');
    expect(out).not.toContain('$0.00');
  });

  // A 37-second, one-item run must not read "1 items, 0.00 h, 0.00 compute units".
  it('stays readable for a short, single-item run', () => {
    const out = formatCostShare({
      ...base,
      itemCount: 1,
      apifyCostUsd: 0.000206,
      inputs: { ...base.inputs, computeUnits: 0.010278, durationHours: 0.010278 },
    });
    expect(out).toContain('- 1 item, 37 s, 0.0103 compute units');
    expect(out).toContain('- Apify: 0.0103 CU × $0.2/CU;');
    expect(out).toContain('~$0.0002 on Apify');
  });

  it('reports sub-hour runs in minutes', () => {
    expect(formatCostShare({ ...base, inputs: { ...base.inputs, durationHours: 0.2 } })).toContain(
      ', 12 min, '
    );
  });

  it('handles a run with no items', () => {
    expect(formatCostShare({ ...base, itemCount: 0 })).toContain('- 0 items, 1.50 h');
  });
});

describe('isUnpricedRunner', () => {
  it('is true only for the default local-docker provider with no recorded price', () => {
    expect(isUnpricedRunner('local-docker', null)).toBe(true);
    // A standalone runner can record RUNNER_PRICE_HOURLY under the default label.
    expect(isUnpricedRunner('local-docker', 0.1)).toBe(false);
    expect(isUnpricedRunner('digitalocean', null)).toBe(false);
    // null = attribution never recorded: unknown, but not known to be self-hosted.
    expect(isUnpricedRunner(null, null)).toBe(false);
  });
});
