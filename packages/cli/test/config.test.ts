/**
 * Unit tests for the multi-profile CLI config store. Each test gets a
 * fresh scratch HOME (CONFIG_DIR is derived from os.homedir() at module
 * load, so vi.resetModules() + a dynamic import pick it up) — the same
 * isolation strategy the integration harness uses.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Mutate process.env keys in place — NEVER replace the process.env object.
// os.homedir() reads the real environment through libuv, and only the
// original process.env proxy propagates writes there; a replaced plain
// object would silently leave $HOME pointing at the real home directory
// and these tests would read/write the user's actual ~/.crawlee-cloud.
const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
const OVERRIDABLE = [
  'CRAWLEE_CLOUD_API_URL',
  'CRAWLEE_CLOUD_TOKEN',
  'CRAWLEE_CLOUD_REGISTRY_URL',
  'CRAWLEE_CLOUD_PROFILE',
] as const;
const scratchRoots: string[] = [];

async function freshConfigModule() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crc-config-test-'));
  scratchRoots.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  const mod = await import('../src/utils/config.js');
  return { mod, home, configFile: path.join(home, '.crawlee-cloud', 'config.json') };
}

beforeEach(() => {
  for (const key of OVERRIDABLE) delete process.env[key];
});

afterAll(async () => {
  if (SAVED.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED.HOME;
  if (SAVED.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = SAVED.USERPROFILE;
  await Promise.all(scratchRoots.map((dir) => fs.remove(dir)));
});

describe('getConfig', () => {
  it('returns hard-coded defaults with no file and no env', async () => {
    const { mod } = await freshConfigModule();
    expect(await mod.getConfig()).toEqual({
      apiBaseUrl: 'http://localhost:3000',
      token: '',
      registryUrl: undefined,
    });
  });

  it('prefers env vars over the persisted profile over defaults', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ apiBaseUrl: 'https://file.example.com', token: 'file-token' });

    process.env.CRAWLEE_CLOUD_API_URL = 'https://env.example.com';

    const config = await mod.getConfig();
    expect(config.apiBaseUrl).toBe('https://env.example.com'); // env wins
    expect(config.token).toBe('file-token'); // file fills the rest
  });

  it('selects the profile named by CRAWLEE_CLOUD_PROFILE', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'default-token' });
    await mod.saveConfig({ token: 'prod-token' }, { profile: 'prod' });

    process.env.CRAWLEE_CLOUD_PROFILE = 'prod';

    expect((await mod.getConfig()).token).toBe('prod-token');
  });

  it('migrates the legacy flat file shape transparently', async () => {
    const { mod, configFile } = await freshConfigModule();
    await fs.ensureDir(path.dirname(configFile));
    await fs.writeJson(configFile, { apiBaseUrl: 'https://old.example.com', token: 'old-token' });

    const config = await mod.getConfig();
    expect(config.apiBaseUrl).toBe('https://old.example.com');
    expect(config.token).toBe('old-token');
    expect(await mod.getActiveProfileName()).toBe('default');
  });
});

describe('saveConfig', () => {
  it('merges into the existing profile instead of replacing it', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ apiBaseUrl: 'https://a.example.com', token: 't1' });
    await mod.saveConfig({ token: 't2' });

    const config = await mod.getConfig();
    expect(config.apiBaseUrl).toBe('https://a.example.com');
    expect(config.token).toBe('t2');
  });

  it('writes the file with owner-only permissions', async () => {
    const { mod, configFile } = await freshConfigModule();
    await mod.saveConfig({ token: 'secret' });

    const mode = (await fs.stat(configFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates a named profile without switching the active one', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'default-token' });
    await mod.saveConfig({ token: 'staging-token' }, { profile: 'staging' });

    expect(await mod.getActiveProfileName()).toBe('default');
    expect((await mod.getConfig()).token).toBe('default-token');
  });

  it('switches the active profile when setActive is passed', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'default-token' });
    await mod.saveConfig({ token: 'prod-token' }, { profile: 'prod', setActive: true });

    expect(await mod.getActiveProfileName()).toBe('prod');
    expect((await mod.getConfig()).token).toBe('prod-token');
  });
});

describe('profile management', () => {
  it('lists profiles with masked token previews', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ apiBaseUrl: 'https://a.example.com', token: 'tok_1234567890abcdef' });
    await mod.saveConfig({ apiBaseUrl: 'https://b.example.com' }, { profile: 'empty' });

    const profiles = await mod.listProfiles();
    const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));
    expect(byName.default).toMatchObject({
      apiBaseUrl: 'https://a.example.com',
      tokenPreview: 'tok_12345678...',
      active: true,
    });
    expect(byName.empty?.tokenPreview).toBe('(no token)');
    expect(byName.empty?.active).toBe(false);
    // The full token never appears in a listing.
    expect(JSON.stringify(profiles)).not.toContain('tok_1234567890abcdef');
  });

  it('useProfile switches and throws on unknown names', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'a' });
    await mod.saveConfig({ token: 'b' }, { profile: 'other' });

    await mod.useProfile('other');
    expect(await mod.getActiveProfileName()).toBe('other');

    await expect(mod.useProfile('ghost')).rejects.toThrow('Profile "ghost" not found');
  });

  it('removeProfile falls back to default when the active profile is removed', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'a' }); // default
    await mod.saveConfig({ token: 'b' }, { profile: 'prod', setActive: true });

    await mod.removeProfile('prod');

    expect(await mod.getActiveProfileName()).toBe('default');
    expect((await mod.listProfiles()).map((p) => p.name)).toEqual(['default']);
  });

  it('removeProfile picks the first remaining profile when default is gone too', async () => {
    const { mod } = await freshConfigModule();
    await mod.saveConfig({ token: 'z' }, { profile: 'zeta', setActive: true });
    await mod.saveConfig({ token: 'a' }, { profile: 'alpha' });

    await mod.removeProfile('zeta');

    expect(await mod.getActiveProfileName()).toBe('alpha');
  });

  it('removeProfile throws on unknown names', async () => {
    const { mod } = await freshConfigModule();
    await expect(mod.removeProfile('ghost')).rejects.toThrow('Profile "ghost" not found');
  });

  it('clearConfig removes the persisted file', async () => {
    const { mod, configFile } = await freshConfigModule();
    await mod.saveConfig({ token: 'secret' });
    expect(await fs.pathExists(configFile)).toBe(true);

    await mod.clearConfig();

    expect(await fs.pathExists(configFile)).toBe(false);
    expect((await mod.getConfig()).token).toBe('');
  });
});
