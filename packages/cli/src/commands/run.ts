/**
 * `crawlee-cloud run` command
 * 
 * Runs an Actor locally with local storage.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import dotenv from 'dotenv';

export const runCommand = new Command('run')
  .description('Run Actor locally')
  .option('-i, --input <json>', 'Input JSON or path to JSON file')
  .option('--no-purge', 'Do not purge storage before run')
  .action(async (options) => {
    console.log(chalk.bold('\n🏃 Running Actor locally\n'));
    
    const cwd = process.cwd();
    
    // Check if we're in an Actor directory
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) {
      console.log(chalk.red('❌ No package.json found. Are you in an Actor directory?'));
      process.exit(1);
    }
    
    // Load .env if exists
    const envPath = path.join(cwd, '.env');
    if (await fs.pathExists(envPath)) {
      dotenv.config({ path: envPath });
    }
    
    // Set up storage directory
    const storageDir = path.join(cwd, 'storage');
    
    // Purge storage if requested
    if (options.purge !== false) {
      console.log(chalk.dim('Purging local storage...'));
      await fs.remove(storageDir);
    }
    
    await fs.ensureDir(path.join(storageDir, 'key_value_stores', 'default'));
    await fs.ensureDir(path.join(storageDir, 'datasets', 'default'));
    await fs.ensureDir(path.join(storageDir, 'request_queues', 'default'));
    
    // Handle input
    if (options.input) {
      let inputData: unknown;
      
      if (options.input.startsWith('{')) {
        // JSON string
        inputData = JSON.parse(options.input);
      } else if (await fs.pathExists(options.input)) {
        // File path
        inputData = await fs.readJson(options.input);
      } else {
        console.log(chalk.red(`❌ Input file not found: ${options.input}`));
        process.exit(1);
      }
      
      // Write input to storage
      await fs.writeJson(
        path.join(storageDir, 'key_value_stores', 'default', 'INPUT.json'),
        inputData,
        { spaces: 2 }
      );
      console.log(chalk.dim('Input saved to storage'));
    }
    
    // Set environment variables for local run
    const env = {
      ...process.env,
      APIFY_LOCAL_STORAGE_DIR: storageDir,
      APIFY_HEADLESS: '1',
      CRAWLEE_STORAGE_DIR: storageDir,
    };
    
    // Determine start command
    const pkg = await fs.readJson(packageJsonPath);
    const startScript = pkg.scripts?.start || pkg.scripts?.['start:dev'];
    
    if (!startScript) {
      console.log(chalk.red('❌ No start script found in package.json'));
      process.exit(1);
    }
    
    console.log(chalk.cyan(`Running: npm start\n`));
    console.log(chalk.dim('─'.repeat(60)));
    
    // Run the Actor
    const child = spawn('npm', ['start'], {
      cwd,
      env,
      stdio: 'inherit',
      shell: true,
    });
    
    child.on('exit', async (code) => {
      console.log(chalk.dim('─'.repeat(60)));
      
      if (code === 0) {
        console.log(chalk.green('\n✅ Actor finished successfully\n'));
        
        // Show dataset summary
        const datasetDir = path.join(storageDir, 'datasets', 'default');
        const files = await fs.readdir(datasetDir).catch(() => []);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        
        if (jsonFiles.length > 0) {
          console.log(chalk.dim(`Dataset: ${jsonFiles.length} items saved`));
          console.log(chalk.dim(`Location: ${datasetDir}`));
        }
      } else {
        console.log(chalk.red(`\n❌ Actor failed with exit code ${code}\n`));
      }
      
      process.exit(code || 0);
    });
  });
