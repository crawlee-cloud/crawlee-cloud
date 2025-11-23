/**
 * `crawlee-cloud push` command
 * 
 * Builds and pushes Actor to the platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs-extra';
import { spawn } from 'child_process';
import { getConfig } from '../utils/config.js';

interface ActorJson {
  actorSpecification?: number;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  dockerfile?: string;
  input?: string;
  output?: string;
  storages?: {
    dataset?: string;
  };
}

function validateActorJson(actorJson: ActorJson): string[] {
  const errors: string[] = [];
  
  if (!actorJson.name) {
    errors.push('Missing required field: "name"');
  } else if (!/^[a-z0-9-]+$/.test(actorJson.name)) {
    errors.push('"name" must contain only lowercase letters, numbers, and hyphens');
  }
  
  if (!actorJson.actorSpecification) {
    errors.push('Missing required field: "actorSpecification"');
  }
  
  return errors;
}

export const pushCommand = new Command('push')
  .description('Push Actor to Crawlee Cloud')
  .option('-t, --tag <tag>', 'Docker image tag', 'latest')
  .option('--no-build', 'Skip Docker build')
  .action(async (options) => {
    console.log(chalk.bold('\n📤 Pushing Actor to Crawlee Cloud\n'));
    
    const cwd = process.cwd();
    const config = await getConfig();
    
    // Check if .actor directory exists
    const actorDir = path.join(cwd, '.actor');
    if (!await fs.pathExists(actorDir)) {
      console.log(chalk.red('❌ No .actor directory found.'));
      console.log(chalk.dim('\nTo create an Actor, run:'));
      console.log(chalk.cyan('  npx apify-cli create my-actor'));
      console.log(chalk.dim('\nOr create .actor/actor.json manually with:'));
      console.log(chalk.dim(`  {
    "actorSpecification": 1,
    "name": "my-actor",
    "title": "My Actor"
  }`));
      process.exit(1);
    }
    
    // Check if actor.json exists
    const actorJsonPath = path.join(actorDir, 'actor.json');
    if (!await fs.pathExists(actorJsonPath)) {
      console.log(chalk.red('❌ No .actor/actor.json found.'));
      console.log(chalk.dim('\nCreate .actor/actor.json with at minimum:'));
      console.log(chalk.dim(`  {
    "actorSpecification": 1,
    "name": "my-actor",
    "title": "My Actor"
  }`));
      process.exit(1);
    }
    
    // Parse and validate actor.json
    let actorJson: ActorJson;
    try {
      actorJson = await fs.readJson(actorJsonPath);
    } catch (err) {
      console.log(chalk.red('❌ Invalid JSON in .actor/actor.json'));
      console.error(err);
      process.exit(1);
    }
    
    // Validate required fields
    const validationErrors = validateActorJson(actorJson);
    if (validationErrors.length > 0) {
      console.log(chalk.red('❌ Invalid .actor/actor.json:'));
      validationErrors.forEach(err => console.log(chalk.red(`   • ${err}`)));
      process.exit(1);
    }
    
    const actorName = actorJson.name!;
    const imageName = `crawlee-cloud/actor-${actorName}:${options.tag}`;
    
    console.log(chalk.dim(`Actor: ${actorName}`));
    if (actorJson.title) console.log(chalk.dim(`Title: ${actorJson.title}`));
    if (actorJson.version) console.log(chalk.dim(`Version: ${actorJson.version}`));
    console.log(chalk.dim(`Image: ${imageName}`));
    console.log();
    
    // Check Dockerfile exists
    const dockerfilePath = actorJson.dockerfile 
      ? path.resolve(cwd, '.actor', actorJson.dockerfile)
      : path.join(cwd, 'Dockerfile');
    
    if (!await fs.pathExists(dockerfilePath)) {
      console.log(chalk.red(`❌ Dockerfile not found at: ${dockerfilePath}`));
      process.exit(1);
    }
    
    // Build Docker image
    if (options.build !== false) {
      const buildSpinner = ora('Building Docker image...').start();
      
      try {
        await runCommand('docker', ['build', '-t', imageName, '.'], cwd);
        buildSpinner.succeed('Docker image built');
      } catch (err) {
        buildSpinner.fail('Docker build failed');
        console.error(err);
        process.exit(1);
      }
    }
    
    // Push to registry (if configured)
    if (config.registryUrl) {
      const pushSpinner = ora('Pushing to registry...').start();
      
      try {
        const remoteImage = `${config.registryUrl}/actor-${actorName}:${options.tag}`;
        await runCommand('docker', ['tag', imageName, remoteImage], cwd);
        await runCommand('docker', ['push', remoteImage], cwd);
        pushSpinner.succeed('Image pushed to registry');
      } catch (err) {
        pushSpinner.fail('Push failed');
        console.error(err);
        process.exit(1);
      }
    }
    
    // Register with API
    const registerSpinner = ora('Registering with platform...').start();
    
    try {
      const response = await fetch(`${config.apiBaseUrl}/v2/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          name: actorName,
          title: actorJson.title,
          description: actorJson.description,
          defaultRunOptions: {
            image: imageName,
          },
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }
      
      registerSpinner.succeed('Registered with platform');
      
      console.log(chalk.green(`\n✅ Actor "${actorName}" pushed successfully!\n`));
      console.log(chalk.dim(`Run with: npx crawlee-cloud call ${actorName}`));
      console.log(chalk.dim(`Dashboard: http://localhost:3001/actors/${actorName}`));
      console.log();
      
    } catch (err) {
      registerSpinner.fail('Registration failed');
      console.error(err);
      process.exit(1);
    }
  });

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe' });
    
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });
  });
}
