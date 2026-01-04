/**
 * Crawlee Cloud CLI
 *
 * Commands:
 *   init             Create new Actor from template
 *   run              Run Actor locally
 *   dev              Run Actor with hot reload
 *   push             Push Actor to platform
 *   call <actor>     Call a remote Actor
 *   logs <run-id>    View run logs
 *   status <run-id>  Check run status
 *   login            Authenticate with platform
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { devCommand } from './commands/dev.js';
import { pushCommand } from './commands/push.js';
import { callCommand } from './commands/call.js';
import { logsCommand } from './commands/logs.js';
import { statusCommand } from './commands/status.js';
import { loginCommand } from './commands/login.js';

export const program = new Command();

program
  .name('crawlee-cloud')
  .description('CLI for Crawlee Cloud - create, run, and deploy Actors')
  .version('0.2.0');

// Register commands
program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(devCommand);
program.addCommand(pushCommand);
program.addCommand(callCommand);
program.addCommand(logsCommand);
program.addCommand(statusCommand);
program.addCommand(loginCommand);

export { program as cli };
