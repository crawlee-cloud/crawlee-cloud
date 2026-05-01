/**
 * Configuration utilities for CLI.
 *
 * The config file supports multiple named "profiles" — separate API URL +
 * token sets for different environments (local / staging / prod / per-team).
 * One profile is active at a time; `getConfig()` returns its values so the
 * rest of the CLI doesn't need to know about profiles at all.
 *
 * Persisted shape (~/.crawlee-cloud/config.json):
 *   {
 *     "activeProfile": "default",
 *     "profiles": {
 *       "default":  { "apiBaseUrl": "...", "token": "...", "registryUrl": "..." },
 *       "prod":     { ... },
 *       "staging":  { ... }
 *     }
 *   }
 *
 * Backwards-compat: if the file is in the OLD flat shape
 *   { "apiBaseUrl": "...", "token": "..." }
 * we migrate it on first read into a `default` profile, transparently.
 *
 * Profile selection precedence (highest wins):
 *   1. CRAWLEE_CLOUD_PROFILE env var (per-invocation override)
 *   2. activeProfile in config.json
 *   3. "default"
 *
 * Env-var overrides for the active profile's fields still apply
 * (CRAWLEE_CLOUD_API_URL, CRAWLEE_CLOUD_TOKEN, etc.) — useful for CI.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

export interface CLIConfig {
  apiBaseUrl: string;
  token: string;
  registryUrl?: string;
}

interface ProfileFile {
  activeProfile?: string;
  profiles?: Record<string, CLIConfig>;
}

const CONFIG_DIR = path.join(os.homedir(), '.crawlee-cloud');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PROFILE = 'default';

/** Read the on-disk file, migrating the old flat shape if needed. */
async function readProfileFile(): Promise<ProfileFile> {
  if (!(await fs.pathExists(CONFIG_FILE))) return {};
  const raw = (await fs.readJson(CONFIG_FILE)) as Record<string, unknown>;

  // Already in profile shape: it has a `profiles` object.
  if (raw && typeof raw === 'object' && 'profiles' in raw) {
    return raw as ProfileFile;
  }

  // Legacy flat shape: { apiBaseUrl, token, registryUrl }. Wrap it as the
  // default profile so the new code paths see a consistent layout. We
  // don't write the migrated file back here — saveConfig() does that on
  // the next mutation, so reading is non-destructive.
  if (raw && typeof raw === 'object' && ('token' in raw || 'apiBaseUrl' in raw)) {
    return {
      activeProfile: DEFAULT_PROFILE,
      profiles: { [DEFAULT_PROFILE]: raw as unknown as CLIConfig },
    };
  }

  return {};
}

/**
 * Resolve which profile to use for this invocation.
 * Looks at CRAWLEE_CLOUD_PROFILE env var first (per-invocation override),
 * then the file's activeProfile, then "default".
 */
function activeProfileName(file: ProfileFile): string {
  return process.env.CRAWLEE_CLOUD_PROFILE || file.activeProfile || DEFAULT_PROFILE;
}

/**
 * Get the effective CLI configuration for the active profile.
 *
 * Resolution order per field (highest wins):
 *   1. Direct env var (CRAWLEE_CLOUD_API_URL, CRAWLEE_CLOUD_TOKEN, ...)
 *   2. Active profile in config.json
 *   3. Hard-coded defaults
 */
export async function getConfig(): Promise<CLIConfig> {
  const envConfig: Partial<CLIConfig> = {
    apiBaseUrl:
      process.env.CRAWLEE_CLOUD_API_URL ||
      process.env.APIFY_API_BASE_URL?.replace('/v2', '') ||
      undefined,
    token: process.env.CRAWLEE_CLOUD_TOKEN || process.env.APIFY_TOKEN || undefined,
    registryUrl: process.env.CRAWLEE_CLOUD_REGISTRY_URL,
  };

  const file = await readProfileFile();
  const name = activeProfileName(file);
  const fromFile = file.profiles?.[name];

  return {
    apiBaseUrl: envConfig.apiBaseUrl ?? fromFile?.apiBaseUrl ?? 'http://localhost:3000',
    token: envConfig.token ?? fromFile?.token ?? '',
    registryUrl: envConfig.registryUrl ?? fromFile?.registryUrl,
  };
}

/**
 * Save (merge) into the active profile. Used by `crc login` to persist
 * after a successful auth handshake.
 *
 * If `profile` is passed, that named profile is updated/created instead
 * of the active one — this is how `crc login --profile prod` adds a new
 * profile without disturbing the active selection.
 */
export async function saveConfig(
  config: Partial<CLIConfig>,
  options: { profile?: string; setActive?: boolean } = {}
): Promise<void> {
  await fs.ensureDir(CONFIG_DIR);

  const file = await readProfileFile();
  const name = options.profile ?? activeProfileName(file);
  const profiles = file.profiles ?? {};
  const existing = profiles[name] ?? { apiBaseUrl: '', token: '' };

  profiles[name] = { ...existing, ...config } as CLIConfig;

  const next: ProfileFile = {
    activeProfile: options.setActive ? name : (file.activeProfile ?? name),
    profiles,
  };

  await fs.writeJson(CONFIG_FILE, next, { spaces: 2, mode: 0o600 });
}

/** Delete every persisted profile + reset active. Used in test cleanup. */
export async function clearConfig(): Promise<void> {
  if (await fs.pathExists(CONFIG_FILE)) {
    await fs.remove(CONFIG_FILE);
  }
}

// ── Profile management ──────────────────────────────────────────────

export interface ProfileSummary {
  name: string;
  apiBaseUrl: string;
  /** First 12 chars of the token, suffix masked. */
  tokenPreview: string;
  active: boolean;
}

/** List every persisted profile with its API URL and a masked token preview. */
export async function listProfiles(): Promise<ProfileSummary[]> {
  const file = await readProfileFile();
  const active = activeProfileName(file);
  const profiles = file.profiles ?? {};
  return Object.entries(profiles).map(([name, p]) => ({
    name,
    apiBaseUrl: p.apiBaseUrl,
    tokenPreview: p.token ? `${p.token.slice(0, 12)}...` : '(no token)',
    active: name === active,
  }));
}

/** Set the active profile. Throws if the named profile doesn't exist. */
export async function useProfile(name: string): Promise<void> {
  const file = await readProfileFile();
  if (!file.profiles?.[name]) {
    throw new Error(
      `Profile "${name}" not found. Run \`crc profile list\` to see available profiles.`
    );
  }
  await fs.writeJson(CONFIG_FILE, { ...file, activeProfile: name }, { spaces: 2, mode: 0o600 });
}

/** Remove a named profile. If it was active, fall back to "default" or first. */
export async function removeProfile(name: string): Promise<void> {
  const file = await readProfileFile();
  if (!file.profiles?.[name]) {
    throw new Error(`Profile "${name}" not found.`);
  }
  delete file.profiles[name];

  // If we removed the active profile, pick a sensible new active so the
  // user isn't left in a "no profile" limbo. Prefer DEFAULT_PROFILE,
  // otherwise the alphabetically first remaining one, otherwise undefined.
  if (file.activeProfile === name) {
    const remaining = Object.keys(file.profiles);
    file.activeProfile = file.profiles[DEFAULT_PROFILE] ? DEFAULT_PROFILE : remaining.sort()[0];
  }

  await fs.writeJson(CONFIG_FILE, file, { spaces: 2, mode: 0o600 });
}

/** Get the currently-active profile's name (after env-var override). */
export async function getActiveProfileName(): Promise<string> {
  const file = await readProfileFile();
  return activeProfileName(file);
}
