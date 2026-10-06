/**
 * `crawlee-cloud call` command
 *
 * Calls a remote Actor on the platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { getConfig } from '../utils/config.js';
import { startRun } from '../utils/runs.js';

/**
 * Collector for -e KEY=VALUE options (can be used multiple times)
 */
export function collectEnvVars(
  value: string,
  previous: Record<string, string>
): Record<string, string> {
  const [key, ...valueParts] = value.split('=');
  if (!key || valueParts.length === 0) {
    console.error(chalk.red(`Invalid env var format: ${value}. Use KEY=VALUE`));
    process.exit(1);
  }
  return { ...previous, [key]: valueParts.join('=') };
}

/** Parser for --timeout / --memory: a positive integer. */
export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`Invalid number: ${value}. Use a positive integer`));
    process.exit(1);
  }
  return n;
}

export const callCommand = new Command('call')
  .description('Call a remote Actor')
  .argument('<actor>', 'Actor name or ID')
  .option('-i, --input <json>', 'Input JSON or path to JSON file')
  .option(
    '-e, --env <KEY=VALUE>',
    'Environment variable (can be used multiple times)',
    collectEnvVars,
    {}
  )
  .option('-w, --wait', 'Wait for run to finish', false)
  // No defaults: when omitted, the actor's default run options apply.
  .option(
    '-t, --timeout <seconds>',
    'Timeout in seconds (default: actor setting)',
    parsePositiveInt
  )
  .option('-m, --memory <mb>', 'Memory in MB (default: actor setting)', parsePositiveInt)
  .action(async (actor, cmdOptions) => {
    const options = cmdOptions as {
      input?: string;
      wait: boolean;
      timeout?: number;
      memory?: number;
      env: Record<string, string>;
    };
    console.log(chalk.bold(`\n📞 Calling Actor: ${actor}\n`));

    const config = await getConfig();

    if (!config.token) {
      console.log(chalk.red('❌ Not logged in. Run: crawlee-cloud login'));
      process.exit(1);
    }

    // Parse input
    let inputData: unknown = {};
    if (options.input) {
      if (options.input.startsWith('{')) {
        inputData = JSON.parse(options.input);
      } else if (await fs.pathExists(options.input)) {
        inputData = await fs.readJson(options.input);
      } else {
        console.log(chalk.red(`❌ Input file not found: ${options.input}`));
        process.exit(1);
      }
    }

    // Get env vars from -e flags
    const envVars = Object.keys(options.env).length > 0 ? options.env : undefined;

    const spinner = ora('Starting Actor run...').start();

    try {
      const run = await startRun(config, actor, {
        input: inputData,
        timeout: options.timeout,
        memory: options.memory,
        envVars,
      });
      const runId = run.id;

      spinner.succeed(`Run started: ${runId}`);

      if (options.wait) {
        console.log(chalk.dim('\nWaiting for run to complete...'));

        // Poll for completion
        let status = 'RUNNING';
        while (status === 'RUNNING' || status === 'READY') {
          await sleep(2000);

          const statusResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
            headers: { Authorization: `Bearer ${config.token}` },
          });

          const statusResult = (await statusResponse.json()) as { data: { status: string } };
          status = statusResult.data.status;

          process.stdout.write('.');
        }

        console.log();

        if (status === 'SUCCEEDED') {
          console.log(chalk.green(`\n✅ Run completed successfully\n`));

          // Fetch and display output
          const outputResponse = await fetch(
            `${config.apiBaseUrl}/v2/actor-runs/${runId}/key-value-store/records/OUTPUT`,
            { headers: { Authorization: `Bearer ${config.token}` } }
          );

          if (outputResponse.ok) {
            const output = await outputResponse.json();
            console.log(chalk.dim('Output:'));
            console.log(JSON.stringify(output, null, 2));
          }
        } else {
          console.log(chalk.red(`\n❌ Run finished with status: ${status}\n`));
        }
      } else {
        console.log(chalk.dim(`\nView logs: crawlee-cloud logs ${runId}`));
      }

      console.log();
    } catch (err) {
      spinner.fail('Failed to start run');
      console.error((err as Error).message);
      process.exit(1);
    }
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
