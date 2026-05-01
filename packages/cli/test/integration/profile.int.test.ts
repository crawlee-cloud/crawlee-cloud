/**
 * `crc profile` + `crc login --profile` end-to-end.
 *
 * Pins the multi-environment workflow:
 *   1. Two `login --profile <X>` calls produce two stored profiles.
 *   2. `profile list` shows both, marks the most-recently-logged-in active.
 *   3. `profile use <name>` switches active.
 *   4. `profile rm <name>` deletes; if active, falls back sensibly.
 *   5. Old flat-shape config files are migrated transparently into a
 *      `default` profile on first read.
 *
 * All filesystem ops happen in an isolated tmp HOME so we never touch the
 * developer's real `~/.crawlee-cloud/config.json`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  API_REACHABLE,
  TEST_API_URL,
  adminToken,
  makeIsolatedHome,
  readPersistedConfig,
  runCli,
} from './setup.js';

describe.skipIf(!API_REACHABLE)('crc profile / crc login --profile (e2e)', () => {
  let token: string;

  beforeAll(async () => {
    token = await adminToken();
  });

  let dispose: () => Promise<void>;
  afterEach(async () => {
    if (dispose) await dispose();
  });

  it('login --profile creates a named profile and makes it active', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const res = await runCli(
      ['login', '--profile', 'staging', '--token', token, '--url', TEST_API_URL],
      { home }
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/profile "staging"/i);

    // Persisted shape: { activeProfile, profiles: { staging: {...} } }.
    // We assert it directly so future shape regressions break here, not
    // silently in production.
    const cfg = (await readPersistedConfig(home)) as {
      activeProfile?: string;
      profiles?: Record<string, { token: string; apiBaseUrl: string }>;
    };
    expect(cfg.activeProfile).toBe('staging');
    expect(cfg.profiles?.staging?.token).toBe(token);
    expect(cfg.profiles?.staging?.apiBaseUrl).toBe(TEST_API_URL);
  });

  it('login twice with different profiles keeps both, marks the second active', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--profile', 'local', '--token', token, '--url', TEST_API_URL], {
      home,
    });
    await runCli(['login', '--profile', 'prod', '--token', token, '--url', TEST_API_URL], { home });

    const list = await runCli(['profile', 'list'], { home });
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/local/);
    expect(list.stdout).toMatch(/prod/);
    // Active marker (`*`) sits next to "prod", since it was the most recent login.
    const lines = list.stdout.split('\n').filter((l) => l.includes('local') || l.includes('prod'));
    const activeLine = lines.find((l) => l.startsWith('*') || /\*\s/.test(l));
    expect(activeLine).toBeDefined();
    expect(activeLine).toMatch(/prod/);
  });

  it('profile use switches the active profile', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--profile', 'a', '--token', token, '--url', TEST_API_URL], { home });
    await runCli(['login', '--profile', 'b', '--token', token, '--url', TEST_API_URL], { home });

    // Switch back to `a`.
    const switchRes = await runCli(['profile', 'use', 'a'], { home });
    expect(switchRes.code).toBe(0);
    expect(switchRes.stdout).toMatch(/Active profile is now "a"/);

    const cfg = (await readPersistedConfig(home)) as { activeProfile?: string };
    expect(cfg.activeProfile).toBe('a');

    // Trying to switch to a profile that doesn't exist must fail loudly.
    const badRes = await runCli(['profile', 'use', 'nonexistent'], { home });
    expect(badRes.code).not.toBe(0);
    expect(badRes.stderr + badRes.stdout).toMatch(/not found/i);
  });

  it('profile rm removes a profile; removing the active falls back', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--profile', 'default', '--token', token, '--url', TEST_API_URL], {
      home,
    });
    await runCli(['login', '--profile', 'temp', '--token', token, '--url', TEST_API_URL], { home });

    // After the second login, "temp" is active. Remove it — fallback should
    // pick "default" since it exists.
    const rmRes = await runCli(['profile', 'rm', 'temp'], { home });
    expect(rmRes.code).toBe(0);

    const cfg = (await readPersistedConfig(home)) as {
      activeProfile?: string;
      profiles?: Record<string, unknown>;
    };
    expect(cfg.profiles?.temp).toBeUndefined();
    expect(cfg.activeProfile).toBe('default');
  });

  it('migrates an old flat config into a `default` profile transparently', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    // Hand-write the legacy shape directly — no CLI involved. This is the
    // upgrade path: a user on the old CLI has this file already.
    const cfgDir = path.join(home, '.crawlee-cloud');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ apiBaseUrl: TEST_API_URL, token, registryUrl: 'ghcr.io/me' }, null, 2)
    );

    // `crc info` reads via getConfig() which is the migration site. If it
    // works, the migration's transparent.
    const info = await runCli(['info'], { home });
    expect(info.code).toBe(0);
    expect(info.stdout).toMatch(/default.*active/i);
    expect(info.stdout).toMatch(new RegExp(TEST_API_URL.replace(/\//g, '\\/')));

    // After a `profile use default` (which writes back), the file should
    // be in the new shape.
    await runCli(['profile', 'use', 'default'], { home });
    const cfg = (await readPersistedConfig(home)) as {
      activeProfile?: string;
      profiles?: Record<string, { token: string }>;
    };
    expect(cfg.activeProfile).toBe('default');
    expect(cfg.profiles?.default?.token).toBe(token);
  });
});
