/**
 * `crawlee-cloud login` command
 *
 * Authenticate with the platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { password, input } from '@inquirer/prompts';
import { saveConfig, getConfig } from '../utils/config.js';

interface LoginOptions {
  token?: string;
  url?: string;
}

interface HealthResponse {
  status: string;
  version?: string;
}

interface UserResponse {
  data: {
    email: string;
  };
}

export const loginCommand = new Command('login')
  .description('Authenticate with Crawlee Cloud')
  .option('-t, --token <token>', 'API token')
  .option('-u, --url <url>', 'API base URL')
  .action(async (options: LoginOptions) => {
    console.log(chalk.bold('\n🔐 Login to Crawlee Cloud\n'));

    const existingConfig = await getConfig();

    // Get API URL
    const apiBaseUrl: string =
      options.url ??
      (await input({
        message: 'API URL:',
        default: existingConfig.apiBaseUrl || 'http://localhost:3000',
      }));

    // Get token
    const token: string =
      options.token ??
      (await password({
        message: 'API Token:',
        mask: '*',
      }));

    // Test connection and validate token
    console.log(chalk.dim('\nValidating credentials...'));

    try {
      // First check if server is reachable
      const healthResponse = await fetch(`${apiBaseUrl}/health`);

      if (!healthResponse.ok) {
        throw new Error(`Server returned ${String(healthResponse.status)}`);
      }

      const health = (await healthResponse.json()) as HealthResponse;

      // Now validate the token by calling an authenticated endpoint
      const authResponse = await fetch(`${apiBaseUrl}/v2/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (authResponse.status === 401 || authResponse.status === 403) {
        throw new Error('Invalid token. Please check your API key and try again.');
      }

      if (!authResponse.ok) {
        throw new Error(`Authentication failed: ${String(authResponse.status)}`);
      }

      const userData = (await authResponse.json()) as UserResponse;

      console.log(chalk.green(`✅ Connected to Crawlee Cloud v${health.version ?? '1.0.0'}`));
      console.log(chalk.dim(`   Authenticated as: ${userData.data.email}`));

      // Save config only after successful validation
      await saveConfig({
        apiBaseUrl,
        token,
      });

      console.log(chalk.dim('\nCredentials saved to ~/.crawlee-cloud/config.json'));
      console.log(chalk.green('\n✅ Login successful!\n'));
    } catch (err) {
      const message = (err as Error).message;
      console.log(chalk.red(`\n❌ ${message}`));

      if (message.includes('Invalid token')) {
        console.log(chalk.dim(`\nGet a valid token from your dashboard: Settings → API Keys`));
      } else {
        console.log(chalk.dim(`\nMake sure the platform is running at ${apiBaseUrl}`));
      }
      process.exit(1);
    }
  });
