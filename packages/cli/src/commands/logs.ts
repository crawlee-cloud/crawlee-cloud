/**
 * `crawlee-cloud logs` command
 * 
 * View logs for a run.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';

export const logsCommand = new Command('logs')
  .description('View logs for a run')
  .argument('<run-id>', 'Run ID')
  .option('-f, --follow', 'Follow logs in real-time', false)
  .action(async (runId, options) => {
    console.log(chalk.bold(`\n📋 Logs for run: ${runId}\n`));
    
    const config = await getConfig();
    
    if (!config.token) {
      console.log(chalk.red('❌ Not logged in. Run: crawlee-cloud login'));
      process.exit(1);
    }
    
    try {
      // Get run info
      const runResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${config.token}` },
      });
      
      if (!runResponse.ok) {
        console.log(chalk.red(`❌ Run not found: ${runId}`));
        process.exit(1);
      }
      
      const run = (await runResponse.json()) as { 
        data: { 
          status: string; 
          actId: string;
          startedAt: string;
          finishedAt: string | null;
        } 
      };
      
      console.log(chalk.dim(`Actor: ${run.data.actId}`));
      console.log(chalk.dim(`Status: ${run.data.status}`));
      console.log(chalk.dim(`Started: ${run.data.startedAt}`));
      if (run.data.finishedAt) {
        console.log(chalk.dim(`Finished: ${run.data.finishedAt}`));
      }
      console.log(chalk.dim('─'.repeat(60)));
      console.log();
      
      if (options.follow && (run.data.status === 'RUNNING' || run.data.status === 'READY')) {
        // Follow logs (simplified - in production would use WebSocket or SSE)
        console.log(chalk.dim('Following logs... (Ctrl+C to stop)\n'));
        
        while (true) {
          await sleep(2000);
          
          const statusResponse = await fetch(`${config.apiBaseUrl}/v2/actor-runs/${runId}`, {
            headers: { 'Authorization': `Bearer ${config.token}` },
          });
          
          const statusResult = await statusResponse.json() as { data: { status: string } };
          
          if (statusResult.data.status !== 'RUNNING' && statusResult.data.status !== 'READY') {
            console.log(chalk.dim(`\nRun finished with status: ${statusResult.data.status}`));
            break;
          }
        }
      } else {
        // For now, just show run status
        // In production, would fetch actual container logs
        console.log(chalk.dim('(Real-time logs not yet implemented - checking run status)'));
        console.log();
        
        if (run.data.status === 'SUCCEEDED') {
          console.log(chalk.green('Run completed successfully'));
        } else if (run.data.status === 'FAILED') {
          console.log(chalk.red('Run failed'));
        } else if (run.data.status === 'RUNNING') {
          console.log(chalk.yellow('Run is still in progress'));
        } else {
          console.log(chalk.dim(`Status: ${run.data.status}`));
        }
      }
      
      console.log();
      
    } catch (err) {
      console.error(chalk.red('Failed to fetch logs:'), (err as Error).message);
      process.exit(1);
    }
  });

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
