/**
 * Production deploy configs must carry everything the API and runner refuse
 * to start without. Every path here sets NODE_ENV=production, where a missing
 * PROXY_ENCRYPTION_KEY is fatal (config-validator.ts, runner config.ts), and
 * the runner must attach actor containers to a network that actually exists.
 * These are read from source so a config edit that drops one fails CI
 * instead of failing someone's first deploy.
 *
 * Assertions match the line that does the work, not just the variable name:
 * a comment or a prompt that mentions PROXY_ENCRYPTION_KEY must not be enough
 * to keep a test green.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

/** The text of a heredoc body, from its opening line to its terminator. */
function heredoc(script: string, opener: string, terminator: string): string {
  const start = script.indexOf(opener);
  expect(start, `heredoc opener not found: ${opener}`).toBeGreaterThan(-1);
  const body = script.slice(start + opener.length);
  const end = body.indexOf(`\n${terminator}\n`);
  expect(end, `heredoc terminator not found: ${terminator}`).toBeGreaterThan(-1);
  return body.slice(0, end);
}

describe('DigitalOcean app specs', () => {
  it.each(['.do/deploy.template.yaml', 'deploy/digitalocean/app.yaml'])(
    '%s asks for PROXY_ENCRYPTION_KEY and API_SECRET as secrets with self-describing placeholders',
    (file) => {
      const spec = read(file);
      expect(spec).toMatch(
        /- key: PROXY_ENCRYPTION_KEY\n\s+type: SECRET\n\s+value: REPLACE_WITH_64_HEX_CHARS\n/
      );
      expect(spec).toMatch(
        /- key: API_SECRET\n\s+type: SECRET\n\s+value: REPLACE_WITH_32_PLUS_CHARS\n/
      );
    }
  );
});

describe('deploy/digitalocean/setup.sh', () => {
  const script = read('deploy/digitalocean/setup.sh');

  it('generates the key once, and reuses one already in the environment on a re-run', () => {
    const assignments = script.match(/^PROXY_ENCRYPTION_KEY=.*openssl.*$/gm);
    expect(assignments).toEqual([
      'PROXY_ENCRYPTION_KEY="${PROXY_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"',
    ]);
  });

  it('passes the key to the API in the app spec', () => {
    expect(script).toMatch(
      /- key: PROXY_ENCRYPTION_KEY\n\s+type: SECRET\n\s+value: "\$\{PROXY_ENCRYPTION_KEY\}"\n/
    );
  });

  it('writes the same key into the runner env file', () => {
    expect(heredoc(script, "cat > /etc/crawlee-runner.env << 'EOF'", 'EOF')).toMatch(
      /^PROXY_ENCRYPTION_KEY=\$\{PROXY_ENCRYPTION_KEY\}$/m
    );
  });
});

describe('deploy/vps', () => {
  const script = read('deploy/vps/deploy.sh');
  const compose = read('deploy/vps/docker-compose.prod.yml');

  it('generates the key exactly once', () => {
    expect(script.match(/PROXY_ENCRYPTION_KEY=\$\(openssl rand -hex 32\)/g)).toHaveLength(1);
  });

  it('writes the key into a fresh .env', () => {
    expect(heredoc(script, 'cat > .env <<EOF', 'EOF')).toMatch(
      /^PROXY_ENCRYPTION_KEY=\$\{PROXY_ENCRYPTION_KEY\}$/m
    );
  });

  it('keeps an existing .env on a re-run and only appends a missing key', () => {
    const guard = script.indexOf('if [[ -f .env ]]; then');
    const write = script.indexOf('cat > .env <<EOF');
    expect(guard).toBeGreaterThan(-1);
    // The overwrite must sit in the else branch of the guard.
    expect(guard).toBeLessThan(write);
    expect(script.slice(guard, write)).toContain('else\n');
    expect(script.slice(guard, write)).toContain(
      "if ! grep -q '^PROXY_ENCRYPTION_KEY=' .env; then"
    );
    // printf with a leading newline: a hand-edited .env may not end in one,
    // and appending straight onto its last line would corrupt that secret.
    expect(script.slice(guard, write)).toContain(
      'printf \'\\nPROXY_ENCRYPTION_KEY=%s\\n\' "${PROXY_ENCRYPTION_KEY}" >> .env'
    );
  });

  it('migrates with a freshly built image before starting the stack', () => {
    const migrate = script.indexOf(
      'docker compose -f docker-compose.prod.yml run --rm --build api node packages/api/dist/db/migrate.js'
    );
    const up = script.indexOf('docker compose -f docker-compose.prod.yml up -d --build\n');
    expect(migrate).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(up);
  });

  it('compose passes the same variable to api and runner', () => {
    expect(compose.match(/^ {6}- PROXY_ENCRYPTION_KEY=\$\{PROXY_ENCRYPTION_KEY\}$/gm)).toHaveLength(
      2
    );
  });

  it('compose names its network explicitly and the runner uses that exact name', () => {
    expect(compose).toMatch(/\n {2}crawlee-network:\n {4}name: crawlee-prod-network\n/);
    expect(compose).toMatch(/^ {6}- DOCKER_NETWORK=crawlee-prod-network$/m);
    expect(compose).not.toContain('crawlee-prod_crawlee-network');
  });
});

describe('deploy/runner/deploy-runner.sh', () => {
  const script = read('deploy/runner/deploy-runner.sh');
  const compose = heredoc(
    script,
    'cat > deploy/runner/docker-compose.runner.yml <<COMPOSE',
    'COMPOSE'
  );

  it('passes the key through to the runner container and writes it to .env', () => {
    // Escaped in the script so it stays a compose variable, not a shell one.
    expect(compose).toMatch(/^ {6}- PROXY_ENCRYPTION_KEY=\\\$\{PROXY_ENCRYPTION_KEY\}$/m);
    expect(heredoc(script, 'cat > deploy/runner/.env <<EOF', 'EOF')).toMatch(
      /^PROXY_ENCRYPTION_KEY=\$\{PROXY_ENCRYPTION_KEY\}$/m
    );
  });

  it('removes a runner started under the old project name before starting the new one', () => {
    // Before the project name was pinned, the stack ran as project `runner`.
    // Left alone, that container (restart: unless-stopped) keeps claiming
    // runs on the old image next to the new one.
    const down = script.indexOf(
      'docker compose -p runner -f docker-compose.runner.yml down 2>/dev/null || true'
    );
    const up = script.indexOf('docker compose -f docker-compose.runner.yml up -d --build');
    expect(down).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(down).toBeLessThan(up);
  });

  it('pins the compose project name so DOCKER_NETWORK names a network that exists', () => {
    // Compose names the default network `<project>_default`, and the project
    // defaults to the directory name (`runner`), not `crawlee-runner`.
    expect(compose).toMatch(/^name: crawlee-runner$/m);
    expect(compose).toMatch(/^ {6}- DOCKER_NETWORK=crawlee-runner_default$/m);
  });
});

describe('stock docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  it('starts the API only if the migration succeeded, with node as the signalled process', () => {
    expect(compose).toContain(
      'command: sh -c "node packages/api/dist/db/migrate.js && exec node packages/api/dist/index.js"'
    );
  });

  it('uses a network name that does not depend on the checkout directory and differs from the VPS stack', () => {
    expect(compose).toMatch(/\n {2}crawlee-network:\n {4}name: crawlee-network\n/);
    expect(compose).toMatch(/^ {6}- DOCKER_NETWORK=crawlee-network$/m);
  });
});
