/**
 * `crawlee-cloud push` command
 *
 * Builds and pushes Actor to the platform.
 *
 * Supports multiple build strategies:
 *   --local (default): build Docker image on the local machine
 *   --remote <host>:   build on a remote runner via SSH
 *   --ghcr <repo>:     build locally, push to GHCR, runners pull
 *
 * On push, the actor is created or updated (upsert) so modifiedAt
 * always reflects the latest deployment.
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
  environmentVariables?: Record<string, string>;
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
  .option('--platform <platform>', 'Docker build platform (e.g. linux/amd64)', '')
  .option('--remote <user@host>', 'Build on a remote runner via SSH')
  .option('--ssh-key <path>', 'SSH key for remote build')
  .option('--ghcr <repo>', 'Push to GitHub Container Registry (e.g. org/repo)')
  .option('--ghcr-user <user>', 'GHCR username (default: github)')
  .option('--ghcr-token <token>', 'GHCR token (or set GHCR_TOKEN env var)')
  .option(
    '-e, --env <KEY=VALUE>',
    'Set actor default env var (repeatable). Empty values are dropped.',
    collectEnv,
    {} as Record<string, string>
  )
  .option(
    '--env-file <path>',
    'Load actor default env vars from a file (KEY=VALUE per line, # comments allowed)'
  )
  .action(async (options) => {
    console.log(chalk.bold('\n📤 Pushing Actor to Crawlee Cloud\n'));

    const cwd = process.cwd();
    const config = await getConfig();

    // Check if .actor directory exists
    const actorDir = path.join(cwd, '.actor');
    if (!(await fs.pathExists(actorDir))) {
      console.log(chalk.red('❌ No .actor directory found.'));
      console.log(chalk.dim('\nCreate .actor/actor.json with:'));
      console.log(
        chalk.dim(`  {
    "actorSpecification": 1,
    "name": "my-actor",
    "title": "My Actor"
  }`)
      );
      process.exit(1);
    }

    // Check if actor.json exists
    const actorJsonPath = path.join(actorDir, 'actor.json');
    if (!(await fs.pathExists(actorJsonPath))) {
      console.log(chalk.red('❌ No .actor/actor.json found.'));
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

    const validationErrors = validateActorJson(actorJson);
    if (validationErrors.length > 0) {
      console.log(chalk.red('❌ Invalid .actor/actor.json:'));
      validationErrors.forEach((err) => console.log(chalk.red(`   • ${err}`)));
      process.exit(1);
    }

    const actorName = actorJson.name!;
    const imageName = `crawlee-cloud/actor-${actorName}:${options.tag as string}`;

    // Determine build mode and the image runners will pull. We resolve
    // both up-front (rather than after the build) so the header line
    // shows the actual deploy target, not the throwaway local tag —
    // otherwise `--ghcr` and `--registry-url` flows print the local
    // `crawlee-cloud/actor-...` tag which is misleading in CI logs and
    // never appears in any registry.
    const buildMode = options.ghcr ? 'ghcr' : options.remote ? 'remote' : 'local';
    const runtimeImage =
      buildMode === 'ghcr'
        ? `ghcr.io/${(options.ghcr as string).toLowerCase()}/actor-${actorName}:${options.tag as string}`
        : config.registryUrl && buildMode === 'local'
          ? `${config.registryUrl}/actor-${actorName}:${options.tag as string}`
          : imageName;

    console.log(chalk.dim(`Actor: ${actorName}`));
    if (actorJson.title) console.log(chalk.dim(`Title: ${actorJson.title}`));
    if (actorJson.version) console.log(chalk.dim(`Version: ${actorJson.version}`));
    console.log(chalk.dim(`Image: ${runtimeImage}`));
    console.log(chalk.dim(`Build: ${buildMode}`));
    console.log();

    // Check Dockerfile exists
    const dockerfilePath = actorJson.dockerfile
      ? path.resolve(cwd, '.actor', actorJson.dockerfile)
      : path.join(cwd, 'Dockerfile');

    if (!(await fs.pathExists(dockerfilePath))) {
      console.log(chalk.red(`❌ Dockerfile not found at: ${dockerfilePath}`));
      process.exit(1);
    }

    // ---- Build image ----
    if (options.build !== false) {
      if (buildMode === 'remote') {
        await buildRemote(cwd, imageName, options);
      } else if (buildMode === 'ghcr') {
        await buildAndPushGhcr(cwd, imageName, actorName, options);
      } else {
        await buildLocal(cwd, imageName, options);
      }
    }

    // ---- Push to registry (if configured in config, separate from GHCR) ----
    if (config.registryUrl && buildMode === 'local') {
      const pushSpinner = ora('Pushing to registry...').start();
      try {
        const remoteImage = `${config.registryUrl}/actor-${actorName}:${options.tag as string}`;
        await runCommand('docker', ['tag', imageName, remoteImage], cwd);
        await runCommand('docker', ['push', remoteImage], cwd);
        pushSpinner.succeed('Image pushed to registry');
      } catch (err) {
        pushSpinner.fail('Push failed');
        console.error(err);
        process.exit(1);
      }
    }

    // ---- Register/update actor (upsert) ----
    const registerSpinner = ora('Registering with platform...').start();

    try {
      // Check if actor exists
      const listRes = await fetch(`${config.apiBaseUrl}/v2/acts?limit=200`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });

      let existingId: string | null = null;
      if (listRes.ok) {
        const listData = (await listRes.json()) as {
          data: { items: { id: string; name: string }[] };
        };
        const existing = listData.data.items.find((a) => a.name === actorName);
        if (existing) existingId = existing.id;
      }

      // Resolve actor default env vars. Precedence (later wins):
      //   actor.json `environmentVariables`
      //     < --env-file (CI-friendly: gitignored .env-style file)
      //       < --env KEY=VALUE flag (per-run override)
      // Empties are dropped from each *override* layer before merging — an
      // empty override means "don't override," so an unset CI secret can't
      // clobber a non-empty actor.json default. (Whatever ships in
      // actor.json is the author's intent, so we don't strip it.)
      const fromActorJson = actorJson.environmentVariables ?? {};
      const fromFile = options.envFile ? await loadEnvFile(options.envFile as string) : {};
      const fromFlag = (options.env as Record<string, string>) ?? {};
      const mergedEnvVars = {
        ...fromActorJson,
        ...dropEmpty(fromFile),
        ...dropEmpty(fromFlag),
      };

      const actorPayload = {
        name: actorName,
        title: actorJson.title,
        description: actorJson.description,
        // Source version from .actor/actor.json. Sent so the API can upsert
        // an actor_versions row and link the build to it. Apify uses this
        // for the version selector on the dashboard's build history.
        version: actorJson.version,
        defaultRunOptions: {
          image: runtimeImage,
          envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
        },
      };

      if (existingId) {
        // Update existing actor (refreshes modifiedAt)
        const response = await fetch(`${config.apiBaseUrl}/v2/acts/${existingId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(actorPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${String(response.status)} - ${errorText}`);
        }

        registerSpinner.succeed('Actor updated');
      } else {
        // Create new actor
        const response = await fetch(`${config.apiBaseUrl}/v2/acts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(actorPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${String(response.status)} - ${errorText}`);
        }

        registerSpinner.succeed('Actor registered');
      }

      console.log(chalk.green(`\n✅ Actor "${actorName}" pushed successfully!\n`));
      console.log(chalk.dim(`Run with: crawlee-cloud call ${actorName}`));
      console.log(chalk.dim(`List:     crawlee-cloud ls`));
      console.log();
    } catch (err) {
      registerSpinner.fail('Registration failed');
      console.error(err);
      process.exit(1);
    }
  });

// ---- Build strategies ----

async function buildLocal(
  cwd: string,
  imageName: string,
  options: { platform?: string }
): Promise<void> {
  const buildSpinner = ora('Building Docker image...').start();
  try {
    const args = ['build', '-t', imageName];
    if (options.platform) {
      args.push('--platform', options.platform);
    }
    args.push('.');
    await runCommand('docker', args, cwd);
    buildSpinner.succeed('Docker image built');
  } catch (err) {
    buildSpinner.fail('Docker build failed');
    console.error(err);
    process.exit(1);
  }
}

async function buildRemote(
  cwd: string,
  imageName: string,
  options: { remote: string; sshKey?: string }
): Promise<void> {
  const buildSpinner = ora(`Building on ${options.remote}...`).start();

  try {
    const sshArgs = options.sshKey ? ['-i', options.sshKey] : [];
    const remoteDir = `/tmp/crawlee-push-${Date.now()}`;

    // Copy build context to remote
    buildSpinner.text = 'Copying build context...';
    await runCommand('scp', [...sshArgs, '-r', '-q', cwd, `${options.remote}:${remoteDir}`], cwd);

    // Build on remote
    buildSpinner.text = 'Building on remote...';
    await runCommand(
      'ssh',
      [...sshArgs, options.remote, `cd ${remoteDir} && docker build -t ${imageName} .`],
      cwd
    );

    // Cleanup remote
    await runCommand('ssh', [...sshArgs, options.remote, `rm -rf ${remoteDir}`], cwd);

    buildSpinner.succeed(`Built on ${options.remote}`);
  } catch (err) {
    buildSpinner.fail('Remote build failed');
    console.error(err);
    process.exit(1);
  }
}

async function buildAndPushGhcr(
  cwd: string,
  _imageName: string,
  actorName: string,
  options: { ghcr: string; ghcrUser?: string; ghcrToken?: string; platform?: string; tag: string }
): Promise<void> {
  const ghcrToken = options.ghcrToken || process.env.GHCR_TOKEN || '';
  const ghcrUser = options.ghcrUser || process.env.GHCR_USER || 'github';
  const ghcrImage = `ghcr.io/${options.ghcr.toLowerCase()}/actor-${actorName}:${options.tag}`;

  if (!ghcrToken) {
    console.log(chalk.red('❌ GHCR token required. Set --ghcr-token or GHCR_TOKEN env var.'));
    process.exit(1);
  }

  // Login to GHCR
  const loginSpinner = ora('Logging in to GHCR...').start();
  try {
    await runCommandWithInput(
      'docker',
      ['login', 'ghcr.io', '-u', ghcrUser, '--password-stdin'],
      ghcrToken,
      cwd
    );
    loginSpinner.succeed('GHCR login OK');
  } catch (err) {
    loginSpinner.fail('GHCR login failed');
    console.error(err);
    process.exit(1);
  }

  // Build
  const buildSpinner = ora('Building Docker image...').start();
  try {
    const args = ['build', '-t', ghcrImage];
    if (options.platform) {
      args.push('--platform', options.platform);
    }
    args.push('.');
    await runCommand('docker', args, cwd);
    buildSpinner.succeed('Docker image built');
  } catch (err) {
    buildSpinner.fail('Docker build failed');
    console.error(err);
    process.exit(1);
  }

  // Push
  const pushSpinner = ora(`Pushing to ${ghcrImage}...`).start();
  try {
    await runCommand('docker', ['push', ghcrImage], cwd);
    pushSpinner.succeed('Pushed to GHCR');
  } catch (err) {
    pushSpinner.fail('GHCR push failed');
    console.error(err);
    process.exit(1);
  }
}

// ---- Helpers ----

/**
 * commander value-collector for repeatable `-e KEY=VALUE` flags.
 * Throws on malformed input rather than silently dropping it — bad args
 * during CI deploys would otherwise look like "no env vars set" later.
 */
function collectEnv(arg: string, prev: Record<string, string>): Record<string, string> {
  const eq = arg.indexOf('=');
  if (eq <= 0) {
    throw new Error(`Invalid --env value "${arg}". Expected KEY=VALUE.`);
  }
  const key = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  return { ...prev, [key]: value };
}

/**
 * Parse a .env-style file into a flat map. Supports `# comments`, blank
 * lines, and quoted values. Does NOT do shell interpolation (no `$VAR`
 * expansion) — that's the caller's job if they want it.
 */
async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  const content = await fs.readFile(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function dropEmpty(map: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe' });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Command failed with code ${String(code)}`));
      }
    });
  });
}

function runCommandWithInput(
  cmd: string,
  args: string[],
  input: string,
  cwd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin?.write(input);
    child.stdin?.end();

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Command failed with code ${String(code)}`));
      }
    });
  });
}
