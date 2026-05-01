/**
 * CLI integration test setup.
 *
 * Spawns the CLI as a real subprocess (via `tsx src/bin.ts`) with an
 * isolated $HOME so tests can never touch the developer's real config at
 * `~/.crawlee-cloud/config.json`. Each test creates a fresh tmp dir and
 * disposes it on teardown.
 *
 * Tests assume an API server is reachable at process.env.CRAWLEE_CLOUD_API_URL
 * (default http://localhost:3000) — the same dev API the rest of the
 * integration tests run against. Spin it up with `npm run docker:dev`
 * + `npm run dev --workspace=@crawlee-cloud/api` before running these.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(__dirname, '../../src/bin.ts');
// tsx may be hoisted to the workspace root by npm — try the local path
// first, then walk up to the workspace root. We resolve once at module
// load to keep spawn() simple.
const TSX_BIN = await (async () => {
  const fsSync = await import('node:fs');
  const candidates = [
    path.resolve(__dirname, '../../node_modules/.bin/tsx'),
    path.resolve(__dirname, '../../../../node_modules/.bin/tsx'),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  throw new Error(`tsx not found; checked: ${candidates.join(', ')}`);
})();

export const TEST_API_URL = process.env.CRAWLEE_CLOUD_API_URL ?? 'http://localhost:3000';
export const TEST_ADMIN_EMAIL = 'admin@local.dev';
export const TEST_ADMIN_PASSWORD = 'admin12345';

export interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  /** HOME dir override — tests pass an isolated tmp dir here. */
  home: string;
  /** Working directory for the spawned process (defaults to home). */
  cwd?: string;
  /** Extra env vars merged with the test defaults. */
  env?: Record<string, string>;
  /** stdin lines to pipe into the CLI for interactive prompts. */
  stdin?: string;
  /** Timeout in ms (default 30s). */
  timeoutMs?: number;
}

/**
 * Run the CLI as a child process. Returns exit code + captured streams.
 *
 * Error handling note: we resolve (not reject) on any exit code so tests
 * can assert on failures explicitly. A spawn-level error (binary not
 * found, etc.) still rejects.
 */
export function runCli(args: string[], options: RunCliOptions): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      // Inherit PATH and the like — without these, `tsx` can't find node.
      ...process.env,
      // Isolate the CLI's config dir from the developer's real ~/.
      HOME: options.home,
      USERPROFILE: options.home, // Windows safety
      // Force the CLI at our test API server.
      CRAWLEE_CLOUD_API_URL: TEST_API_URL,
      // Disable colour so stdout/stderr matching is deterministic.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...options.env,
    };
    // Strip any inherited token so each test starts logged out unless it
    // explicitly provides one.
    delete env.CRAWLEE_CLOUD_TOKEN;
    delete env.APIFY_TOKEN;

    const proc = spawn(TSX_BIN, [CLI_BIN, ...args], {
      cwd: options.cwd ?? options.home,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    proc.on('error', reject);

    if (options.stdin) {
      proc.stdin.write(options.stdin);
    }
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI command timed out: ${args.join(' ')}`));
    }, options.timeoutMs ?? 30_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Allocate a fresh tmp dir for HOME isolation. Returns dispose. */
export async function makeIsolatedHome(): Promise<{ home: string; dispose: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crc-cli-test-'));
  return {
    home,
    dispose: async () => {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/** Read the persisted CLI config file as-is, or null if not written. */
export async function readPersistedConfig(home: string): Promise<unknown> {
  const file = path.join(home, '.crawlee-cloud', 'config.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Read the persisted file and return the *active* profile's fields, or null
 * if the file doesn't exist. Tolerates both the new profile shape and the
 * legacy flat shape (so a test writing the old shape still works).
 */
export async function readActiveProfile(home: string): Promise<{
  apiBaseUrl?: string;
  token?: string;
  registryUrl?: string;
} | null> {
  const raw = (await readPersistedConfig(home)) as {
    activeProfile?: string;
    profiles?: Record<string, unknown>;
    apiBaseUrl?: string;
    token?: string;
  } | null;
  if (!raw) return null;
  // New shape
  if (raw.profiles) {
    const name = raw.activeProfile ?? 'default';
    return (raw.profiles[name] as never) ?? null;
  }
  // Legacy flat shape (pre-migration): the file IS the active profile.
  return raw as never;
}

/**
 * Probe the test API once at module load. CLI integration tests need a
 * running API server (these tests spawn the CLI which then talks to
 * /v2/auth/login etc.). When the server isn't there — typical of CI
 * environments that haven't been wired to start it — we want to skip
 * cleanly rather than fail with ECONNREFUSED in every test's beforeAll.
 *
 * Each test file does `describe.skipIf(!API_REACHABLE)(...)` to honour
 * this: locally, with `npm run docker:dev` + the API running, all tests
 * execute; in a hermetic CI without the API, the suite reports skipped
 * and CI passes.
 */
export const API_REACHABLE = await (async () => {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    const res = await fetch(`${TEST_API_URL}/health`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
})();

/** Get an admin JWT for direct API calls (cleanup, fixtures). */
export async function adminToken(): Promise<string> {
  const res = await fetch(`${TEST_API_URL}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

/** Delete an actor by name, ignoring 404. Used for test cleanup. */
export async function deleteActorByName(name: string, token: string): Promise<void> {
  const res = await fetch(`${TEST_API_URL}/v2/acts/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  // 404 = already gone, 200/204 = deleted. Anything else is a problem.
  if (res.status >= 400 && res.status !== 404) {
    throw new Error(`deleteActorByName(${name}) → HTTP ${res.status}`);
  }
}

/** Write a minimal `.actor/actor.json` + Dockerfile + package.json in `dir`. */
export async function seedActorProject(
  dir: string,
  actorName: string,
  extras: Record<string, unknown> = {}
): Promise<void> {
  const actorDir = path.join(dir, '.actor');
  await fs.mkdir(actorDir, { recursive: true });
  await fs.writeFile(
    path.join(actorDir, 'actor.json'),
    JSON.stringify(
      {
        actorSpecification: 1,
        name: actorName,
        title: `${actorName} test`,
        version: '0.1',
        ...extras,
      },
      null,
      2
    )
  );
  // Dockerfile + package.json so push doesn't fail on basic project shape.
  await fs.writeFile(
    path.join(dir, 'Dockerfile'),
    `FROM node:22-alpine\nWORKDIR /app\nCMD ["node","-e","console.log('test')"]\n`
  );
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: actorName, version: '0.1.0', type: 'module' }, null, 2)
  );
}
