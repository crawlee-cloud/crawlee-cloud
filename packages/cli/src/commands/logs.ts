/**
 * `crawlee-cloud logs` command
 *
 * View logs for a run.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface LogsResponse {
  data: {
    total: number;
    count: number;
    items: LogEntry[];
  };
}

interface RunInfo {
  id: string;
  actId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

interface LogsOptions {
  follow: boolean;
  limit: string;
}

export const logsCommand = new Command('logs')
  .description('View logs for a run')
  .argument('<run-id>', 'Run ID')
  .option('-f, --follow', 'Follow logs in real-time', false)
  .option('-l, --limit <lines>', 'Number of log lines to show', '1000')
  .action(async (runId: string, options: LogsOptions) => {
    console.log(chalk.bold(`\n📋 Logs for run: ${runId}\n`));

    const config = await getConfig();

    if (!config.token) {
      console.log(chalk.red('❌ Not logged in. Run: crawlee-cloud login'));
      process.exit(1);
    }

    try {
      // Get run info
      const runResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });

      if (!runResponse.ok) {
        console.log(chalk.red(`❌ Run not found: ${runId}`));
        process.exit(1);
      }

      const runResult = (await runResponse.json()) as { data: RunInfo };
      const run = runResult.data;

      console.log(chalk.dim(`Actor: ${run.actId}`));
      console.log(chalk.dim(`Status: ${formatStatus(run.status)}`));
      console.log(chalk.dim(`Started: ${new Date(run.startedAt).toLocaleString()}`));
      if (run.finishedAt) {
        console.log(chalk.dim(`Finished: ${new Date(run.finishedAt).toLocaleString()}`));
      }
      console.log(chalk.dim('─'.repeat(60)));
      console.log();

      // Fetch logs from API
      const fetchLogs = async (offset = 0): Promise<LogEntry[]> => {
        const logsResponse = await fetch(
          `${config.apiBaseUrl}/v2/actor-runs/${runId}/logs?limit=${options.limit}&offset=${String(offset)}`,
          { headers: { Authorization: `Bearer ${config.token}` } }
        );

        if (!logsResponse.ok) {
          return [];
        }

        const logsResult = (await logsResponse.json()) as LogsResponse;
        return logsResult.data.items;
      };

      // Print logs
      const printLog = (entry: LogEntry): void => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const level = formatLevel(entry.level);
        console.log(`${chalk.dim(time)} ${level} ${entry.message}`);
      };

      const logs = await fetchLogs();

      if (logs.length === 0) {
        console.log(chalk.dim('No logs available yet.'));

        // Check if run failed without logs - show helpful message
        if (run.status === 'FAILED') {
          console.log();
          console.log(chalk.yellow('💡 Run failed but no logs were captured.'));
          console.log(chalk.dim('   Check runner container logs with:'));
          console.log(chalk.dim('   docker compose logs runner'));
        }
      } else {
        logs.forEach(printLog);
      }

      // Follow mode
      if (options.follow && (run.status === 'RUNNING' || run.status === 'READY')) {
        console.log(chalk.dim('\nFollowing logs... (Ctrl+C to stop)\n'));

        let lastCount = logs.length;
        let isRunning = true;

        while (isRunning) {
          await sleep(2000);

          // Check run status
          const statusResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
            headers: { Authorization: `Bearer ${config.token}` },
          });
          const statusResult = (await statusResponse.json()) as { data: { status: string } };

          // Fetch new logs
          const newLogs = await fetchLogs(lastCount);
          newLogs.forEach(printLog);
          lastCount += newLogs.length;

          if (statusResult.data.status !== 'RUNNING' && statusResult.data.status !== 'READY') {
            console.log(
              chalk.dim(`\nRun finished with status: ${formatStatus(statusResult.data.status)}`)
            );
            isRunning = false;
          }
        }
      } else if (run.status === 'RUNNING') {
        console.log(chalk.dim('\nRun is still in progress. Use -f to follow logs.'));
      }

      console.log();
    } catch (err) {
      console.error(chalk.red('Failed to fetch logs:'), (err as Error).message);
      process.exit(1);
    }
  });

function formatLevel(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return chalk.red('ERR');
    case 'WARN':
    case 'WARNING':
      return chalk.yellow('WRN');
    case 'INFO':
      return chalk.blue('INF');
    case 'DEBUG':
      return chalk.dim('DBG');
    default:
      return chalk.dim(level.slice(0, 3).toUpperCase());
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case 'SUCCEEDED':
      return chalk.green('✓ SUCCEEDED');
    case 'FAILED':
      return chalk.red('✗ FAILED');
    case 'RUNNING':
      return chalk.cyan('⟳ RUNNING');
    case 'READY':
      return chalk.dim('READY');
    default:
      return status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
