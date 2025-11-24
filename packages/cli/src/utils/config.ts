/**
 * Configuration utilities for CLI.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

export interface CLIConfig {
  apiBaseUrl: string;
  token: string;
  registryUrl?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.crawlee-cloud');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Get CLI configuration.
 */
export async function getConfig(): Promise<CLIConfig> {
  // Check environment variables first
  const envConfig: CLIConfig = {
    apiBaseUrl: process.env.CRAWLEE_CLOUD_API_URL || process.env.APIFY_API_BASE_URL?.replace('/v2', '') || 'http://localhost:3000',
    token: process.env.CRAWLEE_CLOUD_TOKEN || process.env.APIFY_TOKEN || '',
    registryUrl: process.env.CRAWLEE_CLOUD_REGISTRY_URL,
  };
  
  // Load from file if exists
  if (await fs.pathExists(CONFIG_FILE)) {
    const fileConfig = await fs.readJson(CONFIG_FILE);
    return {
      ...envConfig,
      ...fileConfig,
    };
  }
  
  return envConfig;
}

/**
 * Save CLI configuration.
 */
export async function saveConfig(config: Partial<CLIConfig>): Promise<void> {
  await fs.ensureDir(CONFIG_DIR);
  
  const existing = await getConfig();
  const merged = { ...existing, ...config };
  
  await fs.writeJson(CONFIG_FILE, merged, { spaces: 2, mode: 0o600 });
}

/**
 * Clear CLI configuration.
 */
export async function clearConfig(): Promise<void> {
  if (await fs.pathExists(CONFIG_FILE)) {
    await fs.remove(CONFIG_FILE);
  }
}
