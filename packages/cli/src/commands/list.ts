/**
 * `crawlee-cloud list` command
 *
 * List actors and runs on the platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';

interface Actor {
  id: string;
  name: string;
  title?: string;
  createdAt: string;
  modifiedAt: string;
}

interface Run {
  id: string;
  actId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'SUCCEEDED':
      return chalk.green(status);
    case 'FAILED':
      return chalk.red(status);
    case 'RUNNING':
      return chalk.yellow(status);
    case 'READY':
      return chalk.cyan(status);
    case 'TIMED-OUT':
      return chalk.red(status);
    case 'ABORTED':
      return chalk.gray(status);
    default:
      return status;
  }
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('List actors and recent runs')
  .option('-a, --actors', 'List actors only')
  .option('-r, --runs', 'List recent runs only')
  .option('-n, --limit <number>', 'Max items to show', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const config = await getConfig();

    const showActors = options.actors || (!options.actors && !options.runs);
    const showRuns = options.runs || (!options.actors && !options.runs);
    const limit = parseInt(options.limit as string, 10);

    try {
      if (showActors) {
        const res = await fetch(`${config.apiBaseUrl}/v2/acts?limit=${String(limit)}`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { error?: { message?: string } }).error?.message || `HTTP ${String(res.status)}`
          );
        }

        const data = (await res.json()) as { data: { items: Actor[]; total: number } };

        // Fetch recent runs to show last run per actor
        const runsRes = await fetch(`${config.apiBaseUrl}/v2/actor-runs?limit=200`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });
        const runsData = runsRes.ok
          ? ((await runsRes.json()) as { data: { items: Run[] } })
          : { data: { items: [] } };

        // Build map: actorId → most recent run
        const lastRunMap = new Map<string, Run>();
        for (const run of runsData.data.items) {
          if (!lastRunMap.has(run.actId)) {
            lastRunMap.set(run.actId, run);
          }
        }

        if (options.json) {
          console.log(JSON.stringify(data.data.items, null, 2));
        } else {
          console.log(chalk.bold(`\nActors (${String(data.data.total)})\n`));

          if (data.data.items.length === 0) {
            console.log(chalk.dim('  No actors found. Push one with: crawlee-cloud push'));
          } else {
            console.log(
              chalk.dim(
                `  ${'NAME'.padEnd(35)} ${'DEPLOYED'.padEnd(12)} ${'LAST RUN'.padEnd(20)} ID`
              )
            );
            for (const actor of data.data.items) {
              const deployed = timeAgo(actor.modifiedAt);
              const lastRun = lastRunMap.get(actor.id);
              const lastRunStr = lastRun
                ? `${statusColor(lastRun.status)} ${timeAgo(lastRun.finishedAt || lastRun.createdAt)}`
                : chalk.dim('never');
              console.log(
                `  ${actor.name.padEnd(35)} ${deployed.padEnd(12)} ${lastRunStr.padEnd(29)} ${chalk.dim(actor.id)}`
              );
            }
          }
          console.log();
        }
      }

      if (showRuns) {
        const res = await fetch(`${config.apiBaseUrl}/v2/actor-runs?limit=${String(limit)}`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { error?: { message?: string } }).error?.message || `HTTP ${String(res.status)}`
          );
        }

        const data = (await res.json()) as { data: { items: Run[]; total: number } };

        // Fetch actor names for display
        const actorRes = await fetch(`${config.apiBaseUrl}/v2/acts?limit=200`, {
          headers: { Authorization: `Bearer ${config.token}` },
        });
        const actorData = actorRes.ok
          ? ((await actorRes.json()) as { data: { items: Actor[] } })
          : { data: { items: [] } };
        const actorMap = new Map(actorData.data.items.map((a) => [a.id, a.name]));

        if (options.json) {
          console.log(JSON.stringify(data.data.items, null, 2));
        } else {
          console.log(
            chalk.bold(
              `\nRuns (${String(data.data.total)} total, showing ${String(data.data.items.length)})\n`
            )
          );

          if (data.data.items.length === 0) {
            console.log(chalk.dim('  No runs found. Start one with: crawlee-cloud call <actor>'));
          } else {
            console.log(
              chalk.dim(`  ${'STATUS'.padEnd(12)} ${'ACTOR'.padEnd(30)} ${'WHEN'.padEnd(12)} ID`)
            );
            for (const run of data.data.items) {
              const actorName = actorMap.get(run.actId) || run.actId;
              const when = timeAgo(run.finishedAt || run.startedAt || run.createdAt);
              console.log(
                `  ${statusColor(run.status).padEnd(21)} ${actorName.padEnd(30)} ${when.padEnd(12)} ${chalk.dim(run.id)}`
              );
            }
          }
          console.log();
        }
      }
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      console.log(chalk.dim(`\nMake sure you're logged in: crawlee-cloud login`));
      process.exit(1);
    }
  });
