/**
 * Scaler cloud-init rendering tests — focused on the RUNNER_CLONE_REF
 * shell-safety boundary (Codex P2 / Gemini high finding on PR #44).
 *
 * Git considers shell metacharacters like `;`, `&`, backticks, `$(...)`,
 * `|`, and newlines valid inside ref names — `git check-ref-format
 * --branch 'foo;bar'` exits 0. Embedding such a value into our bash
 * heredoc unquoted would let an operator-typo turn into RCE on the
 * provisioned droplet. We defend with: (1) an allow-list regex at
 * render time and (2) single-quoting in the rendered command.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('getCloudInitScript — RUNNER_CLONE_REF safety', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUNNER_CLONE_REF;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function getScript() {
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    return getCloudInitScript(3);
  }

  it('emits an unmodified git clone line when RUNNER_CLONE_REF is unset', async () => {
    const script = await getScript();
    expect(script).toContain('git clone https://github.com/crawlee-cloud/crawlee-cloud.git');
    expect(script).not.toContain('--branch');
  });

  it('treats whitespace-only RUNNER_CLONE_REF as unset', async () => {
    process.env.RUNNER_CLONE_REF = '   \t  ';
    const script = await getScript();
    expect(script).not.toContain('--branch');
  });

  it('emits a single-quoted --branch flag when set to a valid ref', async () => {
    process.env.RUNNER_CLONE_REF = 'v0.9.5';
    const script = await getScript();
    expect(script).toContain("git clone --branch 'v0.9.5' https://github.com/");
  });

  it('accepts the realistic ref charset (alphanumeric, ./-_/+)', async () => {
    process.env.RUNNER_CLONE_REF = 'release/0.9.x+build_1-rc';
    const script = await getScript();
    expect(script).toContain("--branch 'release/0.9.x+build_1-rc'");
  });

  it('rejects refs containing a semicolon (command separator)', async () => {
    process.env.RUNNER_CLONE_REF = 'foo;bar';
    await expect(getScript()).rejects.toThrow(/RUNNER_CLONE_REF contains characters outside/);
  });

  it.each([
    ['ampersand', 'main&id'],
    ['backtick', 'main`id`'],
    ['dollar', 'main$(id)'],
    ['pipe', 'main|id'],
    ['newline', 'main\nid'],
    ['space', 'main id'],
    ['single-quote', "main'id"],
  ])('rejects refs with %s', async (_label, value) => {
    process.env.RUNNER_CLONE_REF = value;
    await expect(getScript()).rejects.toThrow(/RUNNER_CLONE_REF contains characters outside/);
  });

  it('trims surrounding whitespace before validating', async () => {
    process.env.RUNNER_CLONE_REF = '   v0.9.5   ';
    const script = await getScript();
    expect(script).toContain("--branch 'v0.9.5'");
  });
});
