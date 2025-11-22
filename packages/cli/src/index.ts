/**
 * Crawlee Cloud CLI
 * 
 * Commands:
 *   run              Run Actor locally
 *   push             Push Actor to platform
 *   call <actor>     Call a remote Actor
 *   logs <run-id>    View run logs
 *   login            Authenticate with platform
 * 
 * Note: To create a new Actor, use `apify create` (official Apify CLI)
 * for 100% compatibility with both Apify Cloud and Crawlee Cloud.
 */

import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { pushCommand } from './commands/push.js';
import { callCommand } from './commands/call.js';
import { logsCommand } from './commands/logs.js';
import { loginCommand } from './commands/login.js';

export const program = new Command();

program
  .name('crawlee-cloud')
  .description('CLI for Crawlee Cloud - run and deploy Actors (use `apify create` to create new Actors)')
  .version('0.1.0');

// Register commands
program.addCommand(runCommand);
program.addCommand(pushCommand);
program.addCommand(callCommand);
program.addCommand(logsCommand);
program.addCommand(loginCommand);

export { program as cli };
