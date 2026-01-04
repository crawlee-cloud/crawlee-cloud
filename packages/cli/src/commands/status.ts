/**
 * `crawlee-cloud status` command
 *
 * Check the status of a run.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../utils/config.js';

interface RunInfo {
  id: string;
  actId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  stats?: {
    durationMillis?: number;
    requestsTotal?: number;
    requestsFinished?: number;
    requestsFailed?: number;
  };
  options?: {
    memoryMbytes?: number;
    timeoutSecs?: number;
  };
}

interface StatusOptions {
  watch?: boolean;
  interval?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${String(mins)}m ${String(secs)}s`;
}

function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    READY: chalk.dim('READY'),
    RUNNING: chalk.cyan('⟳ RUNNING'),
    SUCCEEDED: chalk.green('✓ SUCCEEDED'),
    FAILED: chalk.red('✗ FAILED'),
    ABORTING: chalk.yellow('⏸ ABORTING'),
    ABORTED: chalk.gray('⏹ ABORTED'),
    'TIMING-OUT': chalk.yellow('⏰ TIMING-OUT'),
    'TIMED-OUT': chalk.red('⏰ TIMED-OUT'),
  };
  return statusMap[status] ?? status;
}

export const statusCommand = new Command('status')
  .description('Check the status of a run')
  .argument('<run-id>', 'Run ID to check')
  .option('-w, --watch', 'Watch for updates')
  .option('-i, --interval <seconds>', 'Watch interval in seconds', '5')
  .action(async (runId: string, options: StatusOptions) => {
    const config = await getConfig();

    const fetchStatus = async (): Promise<RunInfo | null> => {
      try {
        const response = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
          headers: {
            Authorization: `Bearer ${config.token}`,
          },
        });

        if (!response.ok) {
          if (response.status === 404) {
            console.log(chalk.red(`❌ Run "${runId}" not found`));
            return null;
          }
          throw new Error(`API error: ${String(response.status)}`);
        }

        const json = (await response.json()) as { data: RunInfo };
        return json.data;
      } catch (err) {
        console.log(chalk.red('❌ Failed to fetch run status'));
        console.error(err);
        return null;
      }
    };

    const displayStatus = (run: RunInfo): void => {
      console.clear();
      console.log(chalk.bold('\n📊 Run Status\n'));

      console.log(chalk.dim('Run ID:     '), run.id);
      console.log(chalk.dim('Actor:      '), run.actId);
      console.log(chalk.dim('Status:     '), formatStatus(run.status));
      console.log(chalk.dim('Started:    '), new Date(run.startedAt).toLocaleString());

      if (run.finishedAt) {
        console.log(chalk.dim('Finished:   '), new Date(run.finishedAt).toLocaleString());
      }

      if (run.stats?.durationMillis) {
        console.log(chalk.dim('Duration:   '), formatDuration(run.stats.durationMillis));
      }

      if (run.stats && (run.stats.requestsTotal ?? run.stats.requestsFinished)) {
        console.log();
        console.log(chalk.bold('Requests:'));
        console.log(chalk.dim('  Total:    '), String(run.stats.requestsTotal ?? 0));
        console.log(
          chalk.dim('  Finished: '),
          chalk.green(String(run.stats.requestsFinished ?? 0))
        );
        console.log(chalk.dim('  Failed:   '), chalk.red(String(run.stats.requestsFailed ?? 0)));
      }

      if (run.options) {
        console.log();
        console.log(chalk.bold('Resources:'));
        if (run.options.memoryMbytes) {
          console.log(chalk.dim('  Memory:   '), `${String(run.options.memoryMbytes)} MB`);
        }
        if (run.options.timeoutSecs) {
          console.log(chalk.dim('  Timeout:  '), `${String(run.options.timeoutSecs)}s`);
        }
      }

      console.log();
    };

    if (options.watch === true) {
      const intervalSecs = options.interval ?? '5';
      const intervalMs = parseInt(intervalSecs, 10) * 1000;
      console.log(chalk.dim(`Watching run status (every ${intervalSecs}s, Ctrl+C to exit)...\n`));

      const check = async (): Promise<void> => {
        const run = await fetchStatus();
        if (!run) {
          process.exit(1);
        }

        displayStatus(run);

        // Stop watching if run is finished
        if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
          console.log(chalk.dim('Run finished. Stopping watch.'));
          process.exit(run.status === 'SUCCEEDED' ? 0 : 1);
        }
      };

      await check();
      setInterval(() => void check(), intervalMs);
    } else {
      const spinner = ora('Fetching run status...').start();
      const run = await fetchStatus();
      spinner.stop();

      if (!run) {
        process.exit(1);
      }

      displayStatus(run);
    }
  });
