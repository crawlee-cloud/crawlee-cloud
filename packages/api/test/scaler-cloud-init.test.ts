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
    // Cost-attribution stamping (claimNextRun writes runner_provider):
    // cloud-init must pin the provider so DO droplets don't fall through
    // to the runner default of 'local-docker'.
    expect(script).toContain('RUNNER_PROVIDER=digitalocean');
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

describe('getCloudInitScript — OOM protection for the control plane', () => {
  // 2026-07-16: with all processes at oom_score_adj 0, host memory
  // exhaustion let the kernel kill the runner/dockerd instead of an
  // actor container — the droplet wedged, its heartbeat died, and its
  // runs zombified. The runner must be near-unkillable so the kernel
  // sacrifices containers (score 0) and the host recovers.
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUNNER_CLONE_REF;
    delete process.env.RUNNER_IMAGE;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('systemd unit protects the runner in git-clone mode', async () => {
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    const script = getCloudInitScript(3);
    expect(script).toContain('OOMScoreAdjust=-900');
  });

  it('docker run protects the runner container in prebuilt-image mode', async () => {
    process.env.RUNNER_IMAGE = 'ghcr.io/crawlee-cloud/runner:v1.2.0';
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    const script = getCloudInitScript(3);
    expect(script).toContain('--oom-score-adj=-900');
  });
});

describe('getCloudInitScript — RUNNER_PRICE_HOURLY cost stamping', () => {
  // The runner stamps runner_price_hourly onto every run at claim time,
  // claim-time-only by design (droplets are destroyed at scale-down and DO
  // reprices) — so a droplet provisioned without this line produces runs
  // that are PERMANENTLY "price not recorded". The env file is the only
  // producer; these tests keep it honest.
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUNNER_CLONE_REF;
    delete process.env.RUNNER_IMAGE;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('bakes the resolved hourly price into the runner env file', async () => {
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    const script = getCloudInitScript(3, 0.03571);
    expect(script).toContain('RUNNER_PRICE_HOURLY=0.03571');
    // Sanity: it lands inside the env-file heredoc, next to the provider.
    expect(script).toContain('RUNNER_PROVIDER=digitalocean');
  });

  it('omits the variable when the price is unresolved (runner degrades to NULL, not 0)', async () => {
    const { getCloudInitScript } = await import('../src/scaler/index.js');
    const script = getCloudInitScript(3, null);
    expect(script).not.toContain('RUNNER_PRICE_HOURLY=');
  });
});
