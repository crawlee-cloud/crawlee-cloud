/**
 * `crawlee-cloud dev` command
 *
 * Runs an Actor in development mode with hot reload.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import { spawn, type ChildProcess } from 'child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import dotenv from 'dotenv';

interface DevOptions {
  watch: boolean;
}

export const devCommand = new Command('dev')
  .description('Run Actor in development mode with hot reload')
  .option('-w, --watch', 'Enable file watching and auto-restart', false)
  .action(async (options: DevOptions) => {
    console.log(chalk.bold('\n🔥 Starting development mode\n'));

    const cwd = process.cwd();

    // Check if we're in an Actor directory
    const packageJsonPath = path.join(cwd, 'package.json');
    const requirementsPath = path.join(cwd, 'requirements.txt');
    const isPython =
      (await fs.pathExists(requirementsPath)) && !(await fs.pathExists(packageJsonPath));

    if (!(await fs.pathExists(packageJsonPath)) && !isPython) {
      console.log(chalk.red('❌ No package.json or requirements.txt found'));
      console.log(chalk.dim('Are you in an Actor directory?'));
      process.exit(1);
    }

    // Load .env if exists
    const envPath = path.join(cwd, '.env');
    if (await fs.pathExists(envPath)) {
      dotenv.config({ path: envPath });
    }

    // Set up storage directory
    const storageDir = path.join(cwd, 'storage');
    await fs.ensureDir(path.join(storageDir, 'key_value_stores', 'default'));
    await fs.ensureDir(path.join(storageDir, 'datasets', 'default'));
    await fs.ensureDir(path.join(storageDir, 'request_queues', 'default'));

    // Environment for the Actor
    const env = {
      ...process.env,
      APIFY_LOCAL_STORAGE_DIR: storageDir,
      APIFY_HEADLESS: '1',
      CRAWLEE_STORAGE_DIR: storageDir,
    };

    let child: ChildProcess | null = null;
    let isRestarting = false;

    const startActor = (): void => {
      if (child) {
        isRestarting = true;
        child.kill();
      }

      // Small delay before restart
      setTimeout(
        () => {
          const timestamp = new Date().toLocaleTimeString();
          console.log(chalk.dim(`[${timestamp}]`), chalk.cyan('Starting Actor...'));
          console.log(chalk.dim('─'.repeat(50)));

          // Cross-platform command detection
          const isWindows = process.platform === 'win32';
          const pythonCmd = isWindows ? 'python' : 'python3';
          const npmCmd = isWindows ? 'npm.cmd' : 'npm';

          const cmd = isPython ? pythonCmd : npmCmd;
          const args = isPython ? ['-m', 'src'] : ['start'];

          child = spawn(cmd, args, {
            cwd,
            env,
            stdio: 'inherit',
            shell: true,
          });

          child.on('exit', (code) => {
            if (!isRestarting) {
              console.log(chalk.dim('─'.repeat(50)));
              if (code === 0) {
                console.log(chalk.green('\n✅ Actor finished'));
              } else {
                console.log(
                  chalk.yellow(`\n⚠️  Actor exited with code ${String(code ?? 'unknown')}`)
                );
              }
              if (options.watch) {
                console.log(chalk.dim('\nWatching for changes... (Ctrl+C to exit)\n'));
              }
            }
            isRestarting = false;
          });
        },
        isRestarting ? 500 : 0
      );
    };

    // Start Actor
    startActor();

    // Watch for changes
    if (options.watch) {
      const watchPaths = isPython
        ? ['src/**/*.py', '*.py']
        : ['src/**/*.ts', 'src/**/*.js', '*.ts', '*.js'];

      const watcher: FSWatcher = chokidar.watch(watchPaths, {
        cwd,
        ignored: ['node_modules', 'storage', 'dist', '.git', '__pycache__'],
        ignoreInitial: true,
      });

      watcher.on('change', (filePath: string) => {
        const timestamp = new Date().toLocaleTimeString();
        console.log(chalk.dim(`\n[${timestamp}]`), chalk.yellow(`File changed: ${filePath}`));
        startActor();
      });

      watcher.on('add', (filePath: string) => {
        const timestamp = new Date().toLocaleTimeString();
        console.log(chalk.dim(`\n[${timestamp}]`), chalk.yellow(`File added: ${filePath}`));
        startActor();
      });

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        console.log(chalk.dim('\n\nShutting down...\n'));
        void watcher.close();
        if (child) child.kill();
        process.exit(0);
      });
    }
  });
