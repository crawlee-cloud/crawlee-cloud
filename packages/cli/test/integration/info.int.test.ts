/**
 * `crc info` end-to-end.
 *
 * Pins the "where am I?" contract:
 *   1. With a valid login, info returns 0 and shows: profile, API URL,
 *      reachable server, valid auth, user email.
 *   2. --json output is machine-parseable.
 *   3. Without a token, info reports "no token" and exits non-zero
 *      (useful as a CI healthcheck: `crc info >/dev/null`).
 *   4. With a wrong API URL, info reports unreachable and exits non-zero.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  API_REACHABLE,
  TEST_API_URL,
  TEST_ADMIN_EMAIL,
  adminToken,
  makeIsolatedHome,
  runCli,
} from './setup.js';

describe.skipIf(!API_REACHABLE)('crc info (e2e)', () => {
  let token: string;

  beforeAll(async () => {
    token = await adminToken();
  });

  let dispose: () => Promise<void>;
  afterEach(async () => {
    if (dispose) await dispose();
  });

  it('exits 0 and shows profile/server/user when logged in', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    const res = await runCli(['info'], { home });
    expect(res.code).toBe(0);
    // High-signal markers — we don't pin exact formatting (it'll evolve)
    // but each of these is something an operator scans for.
    expect(res.stdout).toMatch(/Profile:.*default/);
    expect(res.stdout).toMatch(/API:.*localhost:3000/);
    expect(res.stdout).toMatch(/Server:.*reachable/);
    expect(res.stdout).toMatch(/Auth:.*valid/);
    expect(res.stdout).toContain(TEST_ADMIN_EMAIL);
  });

  it('--json output is machine-parseable', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    const res = await runCli(['info', '--json'], { home });
    expect(res.code).toBe(0);

    const parsed = JSON.parse(res.stdout) as {
      profile: string;
      apiBaseUrl: string;
      serverReachable: boolean;
      authValid: boolean;
      user: { email: string } | null;
      tokenPreview: string;
    };
    expect(parsed.profile).toBe('default');
    expect(parsed.apiBaseUrl).toBe(TEST_API_URL);
    expect(parsed.serverReachable).toBe(true);
    expect(parsed.authValid).toBe(true);
    expect(parsed.user?.email).toBe(TEST_ADMIN_EMAIL);
    // Token preview should be a short masked string, NOT the full token.
    expect(parsed.tokenPreview).toMatch(/\.\.\.$/);
    expect(parsed.tokenPreview).not.toContain(token);
  });

  it('exits non-zero when no token is configured', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    // No login → no profile → no token. info should signal "auth missing".
    const res = await runCli(['info'], { home });
    expect(res.code).not.toBe(0);
    expect(res.stdout).toMatch(/no token|crc login/i);
  });

  it('exits non-zero when API is unreachable', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    // Hand-write a profile pointing at a dead address. We bypass the login
    // command (which would fail at validation) so the file exists for
    // info to read.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const cfgDir = path.join(home, '.crawlee-cloud');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        activeProfile: 'dead',
        profiles: { dead: { apiBaseUrl: 'http://127.0.0.1:1', token } },
      })
    );

    // CRUCIAL: clear the test setup's CRAWLEE_CLOUD_API_URL override so
    // the profile's URL actually wins. Without this, the env-var override
    // points at the live test API and "unreachable" is a lie.
    const infoRes = await runCli(['info'], {
      home,
      env: { CRAWLEE_CLOUD_API_URL: '' },
    });
    expect(infoRes.code).not.toBe(0);
    expect(infoRes.stdout).toMatch(/unreachable/i);
  });
});
