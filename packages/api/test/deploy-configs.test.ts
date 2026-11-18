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
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('generates a key only when none is supplied, and exactly once', () => {
    expect(script.match(/openssl rand -hex 32/g)).toHaveLength(2); // API_SECRET + this key
    expect(script).toContain(
      'PROXY_KEY_SUPPLIED=0\n    PROXY_ENCRYPTION_KEY=$(openssl rand -hex 32)'
    );
  });

  it('refuses to hand an existing app a freshly generated key', () => {
    // A new key makes every stored proxy credential undecryptable. The check
    // must run before anything is created or written.
    const guard = script.indexOf(
      'if [[ -n "${EXISTING_APP_ID}" && "${PROXY_KEY_SUPPLIED}" != 1 ]]; then'
    );
    const spec = script.indexOf('cat > "${SPEC_FILE}" <<SPEC');
    expect(guard).toBeGreaterThan(-1);
    expect(spec).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(spec);
    expect(script.slice(guard, spec)).toMatch(/exit 1\n/);
  });

  describe('find_app_id, run against a stub doctl', () => {
    const fn = script.slice(script.indexOf('find_app_id() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);

    /** Runs find_app_id with `doctl apps list` printing `out` and exiting `code`. */
    function lookup(out: string, code = 0) {
      const dir = mkdtempSync(join(tmpdir(), 'doctl-stub-'));
      try {
        writeFileSync(join(dir, 'out.json'), out);
        const stub = join(dir, 'doctl');
        writeFileSync(stub, `#!/bin/sh\ncat "${join(dir, 'out.json')}"\nexit ${code}\n`);
        chmodSync(stub, 0o755);
        return spawnSync('bash', ['-c', `set -euo pipefail\n${body}\nfind_app_id`], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('prints the id of the crawlee-cloud app', () => {
      const r = lookup(
        '[{"id":"a1","spec":{"name":"other"}},{"id":"a2","spec":{"name":"crawlee-cloud"}}]'
      );
      expect([r.status, r.stdout]).toEqual([0, 'a2']);
    });

    it('succeeds with no output when the listing has no such app', () => {
      expect([lookup('[]').status, lookup('[]').stdout]).toEqual([0, '']);
    });

    // A failed lookup must not read as "no app": setup would then generate a
    // key and push it to the existing app, losing every stored proxy password.
    it.each([
      ['doctl exits non-zero', '', 1],
      ['doctl prints something that is not JSON', 'Error: unauthorized', 0],
      ['doctl prints JSON that is not a list', '{"message":"rate limited"}', 0],
    ])('fails when %s', (_, out, code) => {
      expect(lookup(out, code).status).not.toBe(0);
    });
  });

  it('stops on a failed app lookup and reuses that one lookup to pick update vs create', () => {
    expect(script.match(/\$\(find_app_id\)/g)).toHaveLength(1);
    expect(script).toMatch(/if ! EXISTING_APP_ID=\$\(find_app_id\); then\n(?:.*\n)*?\s+exit 1\n/);
    expect(script).toContain('APP_ID="${EXISTING_APP_ID}"');
  });

  it('writes the app spec, which holds secrets, to an owner-only temp file removed on exit', () => {
    expect(script).not.toContain('/tmp/crawlee-app-spec.yaml');
    expect(script).toContain('SPEC_FILE=$(mktemp)');
    expect(script).toContain(`trap 'rm -f "\${SPEC_FILE}"' EXIT`);
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

  it('generates a new key only as a fallback, under a name Compose does not read', () => {
    // Compose prefers a shell variable over .env. If the operator exported
    // PROXY_ENCRYPTION_KEY, assigning a generated value to that same name
    // would override the key preserved in .env.
    expect(script).toContain(
      'NEW_PROXY_ENCRYPTION_KEY="${PROXY_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"\nunset PROXY_ENCRYPTION_KEY\n'
    );
    expect(script.match(/\$\(openssl rand -hex 32\)/g)).toHaveLength(1);
  });

  it('writes the key into a fresh .env', () => {
    expect(heredoc(script, 'cat > .env <<EOF', 'EOF')).toMatch(
      /^PROXY_ENCRYPTION_KEY=\$\{NEW_PROXY_ENCRYPTION_KEY\}$/m
    );
  });

  it('keeps an existing .env on a re-run: appends a missing key, rejects a malformed one', () => {
    const guard = script.indexOf('if [[ -f .env ]]; then');
    const write = script.indexOf('cat > .env <<EOF');
    expect(guard).toBeGreaterThan(-1);
    // The overwrite must sit in the else branch of the guard.
    expect(guard).toBeLessThan(write);
    const branch = script.slice(guard, write);
    expect(branch).toContain('else\n');
    // Presence and validity are separate checks: an assignment that exists
    // but is empty or malformed must stop the script, not get a second,
    // overriding assignment appended after it.
    expect(branch).toContain('if ! grep -Eq "${PROXY_KEY_ANY}" .env; then');
    expect(branch).toContain('elif ! grep -Eq "${PROXY_KEY_VALID}" .env; then');
    expect(branch).toMatch(/elif ! grep -Eq "\$\{PROXY_KEY_VALID\}" \.env; then\n[^]*?exit 1\n/);
    // printf with a leading newline: a hand-edited .env may not end in one,
    // and appending straight onto its last line would corrupt that secret.
    expect(branch).toContain(
      'printf \'\\nPROXY_ENCRYPTION_KEY=%s\\n\' "${NEW_PROXY_ENCRYPTION_KEY}" >> .env'
    );
  });

  it('migrates with a freshly built image before starting the stack', () => {
    const migrate = script.indexOf(
      'docker compose -f docker-compose.prod.yml run --rm --build api node packages/api/dist/db/migrate.js'
    );
    const up = script.indexOf(
      'docker compose -f docker-compose.prod.yml up -d --build --remove-orphans\n'
    );
    expect(migrate).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(up);
  });

  it('removes containers of services the compose file dropped (the old scheduler) on every update path', () => {
    const readme = read('deploy/README.md');
    for (const text of [script, readme]) {
      const ups = text.match(/docker compose -f docker-compose\.prod\.yml up -d[^\n]*/g) ?? [];
      expect(ups.length).toBeGreaterThan(0);
      for (const up of ups) expect(up).toContain('--remove-orphans');
    }
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

  // Text from `  <name>:` up to the next top-level service (or section).
  // Keeps the newline before the first key so every key matches as `\n    key:`.
  const service = (name: string) =>
    compose.match(
      new RegExp(`\\n {2}${name}:(\\n[\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n|\\n[a-z]+:\\n)`)
    )?.[1] ?? '';

  it('gives Caddy the DOMAIN its Caddyfile reads from its own environment', () => {
    // .env only interpolates the compose file; without this the site address
    // is empty and Caddy rejects the file ("unrecognized global option").
    expect(read('deploy/vps/Caddyfile')).toContain('{$DOMAIN} {');
    expect(service('caddy')).toMatch(/\n {4}environment:\n {6}- DOMAIN=\$\{DOMAIN\}\n/);
  });

  it('bakes the public API URL into the dashboard at build time', () => {
    // Next.js inlines NEXT_PUBLIC_* during `next build`; a runtime-only value
    // leaves the browser bundle on the http://localhost:3000 fallback.
    expect(read('docker/Dockerfile.dashboard')).toContain('ARG NEXT_PUBLIC_API_URL');
    expect(service('dashboard')).toMatch(
      /\n {4}build:\n(?: {6}.*\n)*? {6}args:\n {8}- NEXT_PUBLIC_API_URL=https:\/\/\$\{DOMAIN\}\n/
    );
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

  it('rejects a malformed key at the prompt, before anything is changed', () => {
    const check = script.indexOf('if [[ ! "${PROXY_ENCRYPTION_KEY}" =~ ^[0-9a-fA-F]{64}$ ]]; then');
    const firstChange = script.indexOf('cat > deploy/runner/docker-compose.runner.yml <<COMPOSE');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstChange);
  });

  it('removes a runner started under the old project name, and stops if that fails', () => {
    // Before the project name was pinned, the stack ran as project `runner`.
    // Left alone, that container (restart: unless-stopped) keeps claiming
    // runs on the old image next to the new one. `down` exits 0 when there
    // is nothing to remove, so a failure here is real and must abort.
    const down = script.indexOf('docker compose -p runner -f docker-compose.runner.yml down\n');
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
