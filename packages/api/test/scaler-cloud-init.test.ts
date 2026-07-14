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

describe('getCloudInitScript — RUNNER_IMAGE prebuilt-image mode', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUNNER_CLONE_REF;
    delete process.env.RUNNER_IMAGE;
    delete process.env.SCALER_INSECURE_TLS;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function getScript() {
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    return getCloudInitScript(3);
  }

  it('keeps the git-clone boot path when RUNNER_IMAGE is unset', async () => {
    const script = await getScript();
    expect(script).toContain('git clone');
    expect(script).not.toContain('docker run');
  });

  it('boots from the prebuilt image instead of cloning and building', async () => {
    process.env.RUNNER_IMAGE = 'ghcr.io/crawlee-cloud/runner:v1.0.1';
    const script = await getScript();
    expect(script).toContain("docker pull 'ghcr.io/crawlee-cloud/runner:v1.0.1'");
    expect(script).toContain('docker run -d');
    expect(script).toContain('--restart=always');
    // The runner container must drive sibling actor containers on the host.
    expect(script).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(script).toContain('--env-file /etc/crawlee-runner.env');
    // None of the slow cold-boot steps.
    expect(script).not.toContain('git clone');
    expect(script).not.toContain('npm install');
    expect(script).not.toContain('deb.nodesource.com');
  });

  it('still writes the env file, pins RUNNER_ID from droplet metadata, and signals ready', async () => {
    process.env.RUNNER_IMAGE = 'ghcr.io/crawlee-cloud/runner:v1.0.1';
    const script = await getScript();
    expect(script).toContain('MAX_CONCURRENT_RUNS=3');
    expect(script).toContain('http://169.254.169.254/metadata/v1/id');
    expect(script).toContain('/v2/internal/runner-ready');
  });

  it('retries the image pull before booting (transient registry blips at cold boot)', async () => {
    process.env.RUNNER_IMAGE = 'ghcr.io/crawlee-cloud/runner:v1.0.1';
    const script = await getScript();
    expect(script).toContain(
      "for i in 1 2 3; do docker pull 'ghcr.io/crawlee-cloud/runner:v1.0.1' && break || sleep 10; done"
    );
  });

  it('does not duplicate NODE_TLS_REJECT_UNAUTHORIZED as a -e flag (env-file already carries it)', async () => {
    process.env.RUNNER_IMAGE = 'ghcr.io/crawlee-cloud/runner:v1.0.1';
    process.env.SCALER_INSECURE_TLS = 'true';
    const script = await getScript();
    // The env file injects the variable into the container...
    expect(script).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0');
    // ...so a second copy via `docker run -e` would just be drift bait.
    expect(script).not.toContain('-e NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('accepts a realistic image ref with registry, tag, and digest', async () => {
    process.env.RUNNER_IMAGE =
      'ghcr.io/crawlee-cloud/runner:v1.0.1@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const script = await getScript();
    expect(script).toContain('docker pull');
  });

  it.each([
    ['semicolon', 'evil;id'],
    ['backtick', 'img`id`'],
    ['dollar', 'img$(id)'],
    ['pipe', 'img|id'],
    ['newline', 'img\nid'],
    ['space', 'img id'],
    ['single-quote', "img'id"],
  ])('rejects image refs with %s (heredoc shell-safety)', async (_label, value) => {
    process.env.RUNNER_IMAGE = value;
    await expect(getScript()).rejects.toThrow(/RUNNER_IMAGE contains characters outside/);
  });
});
