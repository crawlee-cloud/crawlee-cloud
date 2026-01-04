/**
 * `crawlee-cloud init` command
 *
 * Scaffolds new Actor projects using official Apify templates.
 * Templates are fetched from: https://github.com/apify/actor-templates
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';

const MANIFEST_URL =
  'https://raw.githubusercontent.com/apify/actor-templates/master/templates/manifest.json';

interface Template {
  id: string;
  name: string;
  label: string;
  category: string;
  description: string;
  archiveUrl: string;
  technologies?: string[];
}

interface Manifest {
  templates: Template[];
}

interface InitOptions {
  template?: string;
  list?: boolean;
}

interface ActorJson {
  name?: string;
  title?: string;
  [key: string]: unknown;
}

export const initCommand = new Command('init')
  .description('Create a new Actor project from template (uses official Apify templates)')
  .argument('[name]', 'Name of the Actor project')
  .option('-t, --template <template>', 'Template ID (e.g., ts-crawlee-cheerio)')
  .option('-l, --list', 'List available templates')
  .action(async (nameArg: string | undefined, options: InitOptions) => {
    console.log(chalk.bold('\n🚀 Create a new Actor project\n'));

    // Fetch templates manifest
    const fetchSpinner = ora('Fetching available templates...').start();
    let manifest: Manifest;

    try {
      const response = await fetch(MANIFEST_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch templates: ${String(response.status)}`);
      }
      manifest = (await response.json()) as Manifest;
      fetchSpinner.succeed(`Found ${String(manifest.templates.length)} templates`);
    } catch (err) {
      fetchSpinner.fail('Failed to fetch templates');
      console.error(err);
      process.exit(1);
    }

    // List mode
    if (options.list === true) {
      console.log(chalk.dim('\nAvailable templates:\n'));

      const categories = [...new Set(manifest.templates.map((t) => t.category))];

      for (const category of categories) {
        console.log(chalk.bold.cyan(`  ${category.toUpperCase()}`));
        const categoryTemplates = manifest.templates.filter((t) => t.category === category);
        for (const t of categoryTemplates) {
          console.log(chalk.white(`    ${t.id}`));
          const desc = t.description ? t.description.slice(0, 60) : '';
          console.log(chalk.dim(`      ${t.label} - ${desc}...`));
        }
        console.log();
      }
      return;
    }

    // Get project name
    let projectName = nameArg ?? '';
    if (!projectName) {
      const answer = await inquirer.prompt<{ name: string }>([
        {
          type: 'input',
          name: 'name',
          message: 'Actor name:',
          default: 'my-actor',
          validate: (input: string) => {
            if (!/^[a-z0-9-]+$/.test(input)) {
              return 'Name must contain only lowercase letters, numbers, and hyphens';
            }
            return true;
          },
        },
      ]);
      projectName = answer.name;
    }

    // Check if directory exists
    const targetDir = path.resolve(process.cwd(), projectName);
    if (await fs.pathExists(targetDir)) {
      console.log(chalk.red(`❌ Directory "${projectName}" already exists`));
      process.exit(1);
    }

    // Get template
    let template: Template | undefined;

    if (options.template) {
      template = manifest.templates.find((t) => t.id === options.template);
      if (!template) {
        console.log(chalk.red(`❌ Template "${options.template}" not found`));
        console.log(chalk.dim('Run `crc init --list` to see available templates'));
        process.exit(1);
      }
    } else {
      // Group templates by category for selection
      const choices = manifest.templates
        .filter(
          (t) =>
            t.category === 'javascript' || t.category === 'typescript' || t.category === 'python'
        )
        .map((t) => ({
          name: `${t.label} ${chalk.dim(`(${t.id})`)}`,
          value: t.id,
          short: t.id,
        }));

      const answer = await inquirer.prompt<{ templateId: string }>([
        {
          type: 'list',
          name: 'templateId',
          message: 'Select a template:',
          choices: [
            new inquirer.Separator(chalk.bold('─── TypeScript ───')),
            ...choices.filter((c) => c.value.startsWith('ts-')),
            new inquirer.Separator(chalk.bold('─── JavaScript ───')),
            ...choices.filter((c) => c.value.startsWith('js-')),
            new inquirer.Separator(chalk.bold('─── Python ───')),
            ...choices.filter((c) => c.value.startsWith('python-')),
          ],
          pageSize: 15,
        },
      ]);

      template = manifest.templates.find((t) => t.id === answer.templateId);
    }

    if (!template) {
      console.log(chalk.red('❌ No template selected'));
      process.exit(1);
    }

    console.log(chalk.dim(`\nTemplate: ${template.label}`));
    console.log(chalk.dim(`Category: ${template.category}`));
    console.log();

    // Download and extract template
    const downloadSpinner = ora('Downloading template...').start();

    try {
      const response = await fetch(template.archiveUrl);
      if (!response.ok) {
        throw new Error(`Failed to download: ${String(response.status)}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      downloadSpinner.text = 'Extracting template...';

      const zip = new AdmZip(buffer);

      // Create target directory
      await fs.ensureDir(targetDir);

      // Extract files
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.isDirectory) continue;

        // Remove the top-level directory from the path (e.g., "ts-crawlee-cheerio/")
        const entryPath = entry.entryName;
        const pathParts = entryPath.split('/');
        const relativePath = pathParts.slice(1).join('/');

        if (!relativePath) continue;

        const targetPath = path.join(targetDir, relativePath);
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, entry.getData());
      }

      downloadSpinner.succeed('Template extracted');
    } catch (err) {
      downloadSpinner.fail('Failed to download template');
      console.error(err);
      process.exit(1);
    }

    // Update actor.json with project name
    const actorJsonPath = path.join(targetDir, '.actor', 'actor.json');
    if (await fs.pathExists(actorJsonPath)) {
      try {
        const actorJson = (await fs.readJson(actorJsonPath)) as ActorJson;
        actorJson.name = projectName;
        actorJson.title = projectName
          .split('-')
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        await fs.writeJson(actorJsonPath, actorJson, { spaces: 4 });
      } catch {
        // Ignore if actor.json update fails
      }
    }

    // Install dependencies
    const isPython = template.category === 'python';
    const installSpinner = ora('Installing dependencies...').start();

    try {
      const { spawn } = await import('child_process');

      // Cross-platform command detection
      const isWindows = process.platform === 'win32';
      const pythonCmd = isWindows ? 'python' : 'python3';
      const npmCmd = isWindows ? 'npm.cmd' : 'npm';

      await new Promise<void>((resolve, reject) => {
        const cmd = isPython ? pythonCmd : npmCmd;
        const args = isPython ? ['-m', 'pip', 'install', '-r', 'requirements.txt'] : ['install'];

        const child = spawn(cmd, args, {
          cwd: targetDir,
          stdio: 'pipe',
          shell: true,
        });

        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with code ${String(code)}`));
        });

        child.on('error', reject);
      });

      installSpinner.succeed('Dependencies installed');
    } catch {
      installSpinner.warn('Could not install dependencies (run manually)');
    }

    // Success message
    console.log(chalk.green(`\n✅ Actor "${projectName}" created successfully!\n`));
    console.log(chalk.bold('Next steps:'));
    console.log(chalk.cyan(`  cd ${projectName}`));
    console.log(chalk.cyan('  crc run                  # Run locally'));
    console.log(chalk.cyan('  crc push                 # Push to Crawlee Cloud'));
    console.log();
    console.log(chalk.dim('Template from: github.com/apify/actor-templates'));
    console.log();
  });
