/**
 * One-time post-success feedback note.
 *
 * After the FIRST successful `push`, print a short invitation to share
 * deployment feedback (GitHub Discussions + free setup-help offer), then
 * never again. The "shown" marker is a standalone file in the config dir
 * rather than a key in config.json so it survives profile edits and stays
 * out of the typed CLIConfig shape.
 *
 * This is a printed link only — no network calls, no telemetry. It must
 * never break the command that triggered it (CI deploys included), so
 * every failure mode is swallowed. Suppressed when not a TTY (CI logs)
 * or when CRAWLEE_CLOUD_NO_FEEDBACK_NOTE is set.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const MARKER_FILE = path.join(os.homedir(), '.crawlee-cloud', 'feedback-note-shown');

export async function maybeShowFeedbackNote(): Promise<void> {
  try {
    if (!process.stdout.isTTY) return;
    if (process.env.CRAWLEE_CLOUD_NO_FEEDBACK_NOTE) return;
    if (await fs.pathExists(MARKER_FILE)) return;

    await fs.ensureDir(path.dirname(MARKER_FILE));
    await fs.writeFile(MARKER_FILE, new Date().toISOString() + '\n');

    console.log(chalk.dim('────────────────────────────────────────────────────────'));
    console.log(chalk.bold('🎉 First push! Two quick asks (this message shows once):'));
    console.log(
      `   ${chalk.cyan('Tell us how the setup went:')} https://github.com/crawlee-cloud/crawlee-cloud/issues/new?template=deployment_report.yml`
    );
    console.log(
      `   ${chalk.cyan('Stuck or have questions?')}    https://github.com/crawlee-cloud/crawlee-cloud/discussions`
    );
    console.log(chalk.dim('   Free 15-min setup help: aminembarki@gmail.com'));
    console.log(chalk.dim('────────────────────────────────────────────────────────'));
    console.log();
  } catch {
    // A feedback nudge must never break a deploy — swallow everything.
  }
}
