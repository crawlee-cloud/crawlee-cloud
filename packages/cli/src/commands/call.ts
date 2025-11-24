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

export const callCommand = new Command('call')
  .description('Call a remote Actor')
  .argument('<actor>', 'Actor name or ID')
  .option('-i, --input <json>', 'Input JSON or path to JSON file')
  .option('-w, --wait', 'Wait for run to finish', false)
  .option('-t, --timeout <seconds>', 'Timeout in seconds', '3600')
  .option('-m, --memory <mb>', 'Memory in MB', '1024')
  .action(async (actor, options) => {
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
    
    const spinner = ora('Starting Actor run...').start();
    
    try {
      // Start the run
      const response = await fetch(`${config.apiBaseUrl}/v2/acts/${actor}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          input: inputData,
          timeout: parseInt(options.timeout, 10),
          memory: parseInt(options.memory, 10),
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
      }
      
      const result = await response.json() as { data: { id: string; status: string } };
      const runId = result.data.id;
      
      spinner.succeed(`Run started: ${runId}`);
      
      if (options.wait) {
        console.log(chalk.dim('\nWaiting for run to complete...'));
        
        // Poll for completion
        let status = 'RUNNING';
        while (status === 'RUNNING' || status === 'READY') {
          await sleep(2000);
          
          const statusResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
            headers: { 'Authorization': `Bearer ${config.token}` },
          });
          
          const statusResult = await statusResponse.json() as { data: { status: string } };
          status = statusResult.data.status;
          
          process.stdout.write('.');
        }
        
        console.log();
        
        if (status === 'SUCCEEDED') {
          console.log(chalk.green(`\n✅ Run completed successfully\n`));
          
          // Fetch and display output
          const outputResponse = await fetch(
            `${config.apiBaseUrl}/v2/actor-runs/${runId}/key-value-store/records/OUTPUT`,
            { headers: { 'Authorization': `Bearer ${config.token}` } }
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
  return new Promise(resolve => setTimeout(resolve, ms));
}
