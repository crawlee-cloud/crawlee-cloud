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
import chalk from 'chalk';
import { CONFIG_DIR } from './config.js';

const MARKER_FILE = path.join(CONFIG_DIR, 'feedback-note-shown');

export async function maybeShowFeedbackNote(): Promise<void> {
  try {
    if (!process.stdout.isTTY) return;
    if (process.env.CRAWLEE_CLOUD_NO_FEEDBACK_NOTE) return;

    await fs.ensureDir(CONFIG_DIR);
    // Exclusive create: EEXIST means the note was already shown (and also
    // closes the check-then-write TOCTOU a pathExists() pre-check would
    // have). EEXIST lands in the catch below and exits silently, which is
    // exactly the wanted behavior.
    await fs.writeFile(MARKER_FILE, new Date().toISOString() + '\n', {
      flag: 'wx',
      mode: 0o600,
    });

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
    // Already shown (EEXIST) or anything else — a feedback nudge must
    // never break a deploy, so every failure mode is silent.
  }
}
