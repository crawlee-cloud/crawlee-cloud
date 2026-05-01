/**
 * `crc login` end-to-end.
 *
 * Pins the contract that:
 *   - a valid token + URL persists config to <home>/.crawlee-cloud/config.json
 *   - an invalid token exits non-zero AND does NOT clobber existing config
 *   - the saved config matches what was provided on the CLI
 *
 * No mocks: hits the real API and writes a real config file in an isolated
 * tmp HOME so the developer's actual credentials are never touched.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  API_REACHABLE,
  TEST_API_URL,
  adminToken,
  makeIsolatedHome,
  readActiveProfile,
  readPersistedConfig,
  runCli,
} from './setup.js';

describe.skipIf(!API_REACHABLE)('crc login (e2e)', () => {
  let token: string;

  beforeAll(async () => {
    token = await adminToken();
  });

  let dispose: () => Promise<void>;
  afterEach(async () => {
    if (dispose) await dispose();
  });

  it('persists config on valid token', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const res = await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Login successful/);
    expect(res.stdout).toMatch(/admin@local\.dev/);

    const active = await readActiveProfile(home);
    expect(active).not.toBeNull();
    expect(active.apiBaseUrl).toBe(TEST_API_URL);
    expect(active.token).toBe(token);
  });

  it('exits non-zero on invalid token and does not save config', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const res = await runCli(
      ['login', '--token', 'cp_obviouslynotvalid_zzzzzzzzzzzzzzzzz', '--url', TEST_API_URL],
      { home }
    );

    expect(res.code).not.toBe(0);
    // Match by substring rather than exact string — chalk colour codes
    // are stripped via NO_COLOR in setup, but other formatting might shift.
    expect(res.stdout + res.stderr).toMatch(/Invalid token|Authentication failed/);

    // Config must be untouched. The contract is "save only after successful
    // validation" (login.ts:86) — a regression that wrote first would fail here.
    const cfg = await readPersistedConfig(home);
    expect(cfg).toBeNull();
  });

  it('reports server-unreachable cleanly without crashing', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const res = await runCli(['login', '--token', token, '--url', 'http://127.0.0.1:1'], { home });

    expect(res.code).not.toBe(0);
    // Helpful "platform is running at" hint should be visible. Catches a
    // class of regression where the catch block hides the URL the user
    // typed.
    expect(res.stdout + res.stderr).toMatch(/platform is running at/);
    expect(await readPersistedConfig(home)).toBeNull();
  });
});
