/**
 * `crawlee-cloud profile` command.
 *
 * Switch / list / remove named profiles. A profile is a stored API URL +
 * token pair; one is active at a time. See utils/config.ts for the
 * persisted shape and resolution rules.
 *
 * Subcommands:
 *   crc profile list           # show all profiles, mark active
 *   crc profile use <name>     # switch active profile
 *   crc profile rm  <name>     # delete a profile
 *
 * Use `crc login --profile <name>` to create a new profile.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { listProfiles, useProfile, removeProfile } from '../utils/config.js';

export const profileCommand = new Command('profile')
  .description('Manage saved login profiles (multiple environments / accounts)')
  .addHelpText(
    'after',
    '\nCreate a profile with `crc login --profile <name>`. Use `crc info` to see the active profile.'
  );

profileCommand
  .command('list')
  .alias('ls')
  .description('List all profiles. The active one is marked.')
  .action(async () => {
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      console.log(chalk.dim('No profiles configured. Run `crc login` to create one.'));
      return;
    }
    // Two-column-ish layout: marker + name + url + token preview.
    // We don't pull in `table` here because the formatting is so simple
    // it'd be overkill for a four-column print.
    const namePad = Math.max(...profiles.map((p) => p.name.length), 7);
    for (const p of profiles) {
      const marker = p.active ? chalk.green('* ') : '  ';
      const name = (p.active ? chalk.green : chalk.white)(p.name.padEnd(namePad));
      console.log(`${marker}${name}  ${chalk.dim(p.apiBaseUrl)}  ${chalk.dim(p.tokenPreview)}`);
    }
  });

profileCommand
  .command('use')
  .description('Set the active profile')
  .argument('<name>', 'Profile name to switch to')
  .action(async (name: string) => {
    try {
      await useProfile(name);
      console.log(chalk.green(`✅ Active profile is now "${name}"`));
    } catch (err) {
      console.error(chalk.red(`❌ ${(err as Error).message}`));
      process.exit(1);
    }
  });

profileCommand
  .command('rm')
  .alias('remove')
  .description('Remove a saved profile')
  .argument('<name>', 'Profile name to remove')
  .action(async (name: string) => {
    try {
      await removeProfile(name);
      console.log(chalk.green(`✅ Removed profile "${name}"`));
    } catch (err) {
      console.error(chalk.red(`❌ ${(err as Error).message}`));
      process.exit(1);
    }
  });
