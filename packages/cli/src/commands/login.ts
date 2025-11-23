/**
 * `crawlee-cloud login` command
 * 
 * Authenticate with the platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { password, input } from '@inquirer/prompts';
import { saveConfig, getConfig } from '../utils/config.js';

export const loginCommand = new Command('login')
  .description('Authenticate with Crawlee Cloud')
  .option('-t, --token <token>', 'API token')
  .option('-u, --url <url>', 'API base URL')
  .action(async (options) => {
    console.log(chalk.bold('\n🔐 Login to Crawlee Cloud\n'));
    
    const existingConfig = await getConfig();
    
    // Get API URL
    const apiBaseUrl = options.url || await input({
      message: 'API URL:',
      default: existingConfig.apiBaseUrl || 'http://localhost:3000',
    });
    
    // Get token
    const token = options.token || await password({
      message: 'API Token:',
      mask: '*',
    });
    
    // Test connection
    console.log(chalk.dim('\nTesting connection...'));
    
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      
      const health = await response.json() as { status: string; version: string };
      
      console.log(chalk.green(`✅ Connected to Crawlee Cloud v${health.version}`));
      
      // Save config
      await saveConfig({
        apiBaseUrl,
        token,
      });
      
      console.log(chalk.dim('\nCredentials saved to ~/.crawlee-cloud/config.json'));
      console.log(chalk.green('\n✅ Login successful!\n'));
      
    } catch (err) {
      console.log(chalk.red(`\n❌ Failed to connect: ${(err as Error).message}`));
      console.log(chalk.dim(`\nMake sure the platform is running at ${apiBaseUrl}`));
      process.exit(1);
    }
  });
