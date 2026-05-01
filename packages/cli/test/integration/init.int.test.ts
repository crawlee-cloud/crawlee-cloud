/**
 * `crc init` end-to-end.
 *
 * The init command pulls templates from
 *   https://raw.githubusercontent.com/apify/actor-templates/master/templates/manifest.json
 * at runtime — that's a hard network dependency. These tests detect
 * unreachable upstream once and `skip` if offline, so a hermetic CI
 * doesn't fail. When upstream is reachable we exercise:
 *   1. `crc init --list` returns templates without writing any file
 *   2. `crc init <name> --template <id>` scaffolds a real project under
 *      cwd with the expected actor.json + Dockerfile + package.json
 *
 * Each test uses an isolated tmp HOME for cwd; init never touches the
 * developer's real filesystem.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeIsolatedHome, runCli } from './setup.js';

const MANIFEST_URL =
  'https://raw.githubusercontent.com/apify/actor-templates/master/templates/manifest.json';

describe('crc init (e2e, network-dependent)', () => {
  let networkOk = false;
  let availableTemplates: Array<{ id: string; archiveUrl?: string }> = [];

  beforeAll(async () => {
    // Probe upstream once. AbortController gives us a hard 5s ceiling so
    // CI doesn't hang an extra TCP timeout on a flaky network.
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5_000);
      const res = await fetch(MANIFEST_URL, { signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) {
        const body = (await res.json()) as {
          templates: Array<{ id: string; archiveUrl?: string }>;
        };
        availableTemplates = body.templates;
        networkOk = true;
      }
    } catch {
      networkOk = false;
    }
  });

  let dispose: () => Promise<void>;
  afterEach(async () => {
    if (dispose) await dispose();
  });

  it('--list shows available templates and creates no files', async () => {
    if (!networkOk) {
      console.warn('[skip] github.com unreachable, skipping init --list');
      return;
    }
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const res = await runCli(['init', '--list'], { home });
    expect(res.code).toBe(0);

    // Output should mention at least one well-known template id. We don't
    // pin a specific id (the manifest evolves) — just that the listing is
    // non-empty and looks like template ids.
    expect(res.stdout).toMatch(/[a-z][a-z0-9-]+/);

    // Sanity: --list should not have created any directory in HOME.
    const homeContents = await fs.readdir(home);
    expect(homeContents).toHaveLength(0);
  });

  it('--template <id> scaffolds actor.json + Dockerfile in cwd', async () => {
    if (!networkOk || availableTemplates.length === 0) {
      console.warn('[skip] github.com unreachable, skipping init scaffold');
      return;
    }
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    // Pick the first template that has an archiveUrl. ts-crawlee-cheerio
    // is typical, but we don't hard-code it — just take whatever upstream
    // currently advertises so the test stays alive across template churn.
    const template = availableTemplates.find((t) => t.archiveUrl)?.id;
    if (!template) {
      console.warn('[skip] no usable template in manifest');
      return;
    }

    const projectName = `init-test-${Date.now()}`;
    const res = await runCli(['init', projectName, '--template', template], {
      home,
      cwd: home,
    });
    expect(res.code).toBe(0);

    // Required files dropped by every official template.
    const projectDir = path.join(home, projectName);
    const actorJsonPath = path.join(projectDir, '.actor', 'actor.json');
    expect(await fileExists(actorJsonPath)).toBe(true);
    expect(await fileExists(path.join(projectDir, 'Dockerfile'))).toBe(true);

    // actor.json should contain at minimum the project name + actorSpecification:1.
    const actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf-8')) as {
      name: string;
      actorSpecification: number;
    };
    expect(actorJson.name).toBe(projectName);
    expect(actorJson.actorSpecification).toBe(1);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
