/**
 * Unit tests for the one-time post-push feedback note. Uses the same
 * fresh-scratch-HOME isolation as config.test.ts: MARKER_FILE is derived
 * from os.homedir() at module load, so vi.resetModules() + a dynamic
 * import pick up the per-test HOME.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
const scratchRoots: string[] = [];

// The note is suppressed off-TTY (CI logs); tests force a TTY unless the
// case under test is exactly that suppression.
const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

async function freshFeedbackModule() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crc-feedback-test-'));
  scratchRoots.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  const mod = await import('../src/utils/feedback.js');
  return { mod, marker: path.join(home, '.crawlee-cloud', 'feedback-note-shown') };
}

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  delete process.env.CRAWLEE_CLOUD_NO_FEEDBACK_NOTE;
  setTTY(true);
});

afterEach(() => {
  if (savedIsTTY) Object.defineProperty(process.stdout, 'isTTY', savedIsTTY);
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (SAVED.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED.HOME;
  if (SAVED.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = SAVED.USERPROFILE;
  await Promise.all(scratchRoots.map((dir) => fs.remove(dir)));
});

describe('maybeShowFeedbackNote', () => {
  it('prints once and writes the marker file', async () => {
    const { mod, marker } = await freshFeedbackModule();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.maybeShowFeedbackNote();

    expect(log).toHaveBeenCalled();
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('deployment_report');
    expect(output).toContain('discussions');
    expect(await fs.pathExists(marker)).toBe(true);
  });

  it('is silent on subsequent calls', async () => {
    const { mod } = await freshFeedbackModule();
    const first = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mod.maybeShowFeedbackNote();
    first.mockClear();

    await mod.maybeShowFeedbackNote();

    expect(first).not.toHaveBeenCalled();
  });

  it('is suppressed by CRAWLEE_CLOUD_NO_FEEDBACK_NOTE', async () => {
    const { mod, marker } = await freshFeedbackModule();
    process.env.CRAWLEE_CLOUD_NO_FEEDBACK_NOTE = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.maybeShowFeedbackNote();

    expect(log).not.toHaveBeenCalled();
    expect(await fs.pathExists(marker)).toBe(false);
  });

  it('is suppressed when stdout is not a TTY (CI)', async () => {
    const { mod, marker } = await freshFeedbackModule();
    setTTY(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.maybeShowFeedbackNote();

    expect(log).not.toHaveBeenCalled();
    expect(await fs.pathExists(marker)).toBe(false);
  });
});
