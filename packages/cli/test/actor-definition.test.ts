/**
 * Unit tests for `resolveActorDefinitionWithSources` (#116): how `crc push` finds the
 * input schema and README it uploads as `actorDefinition`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  ActorDefinitionError,
  MAX_ACTOR_INPUT_SCHEMA_BYTES,
  MAX_ACTOR_README_BYTES,
  MAX_ACTOR_DEFINITION_BYTES,
  resolveActorDefinitionWithSources,
} from '../src/utils/actor-definition.js';

const SCHEMA = {
  title: 'Input',
  type: 'object',
  schemaVersion: 1,
  properties: { url: { type: 'string', title: 'URL' } },
  required: ['url'],
};

const BASE = { actorSpecification: 1, name: 'my-actor', version: '0.1' };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crc-actor-def-'));
  await fs.ensureDir(path.join(root, '.actor'));
});

afterEach(async () => {
  await fs.remove(root);
});

async function write(rel: string, content: string | object): Promise<void> {
  const file = path.join(root, rel);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  );
}

async function resolve(
  dir: string,
  actorJson: Parameters<typeof resolveActorDefinitionWithSources>[1]
) {
  return (await resolveActorDefinitionWithSources(dir, actorJson)).definition;
}

describe('resolveActorDefinitionWithSources: payload shape', () => {
  it('copies actorSpecification, name and version and omits absent input/readme keys', async () => {
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition).toEqual({ actorSpecification: 1, name: 'my-actor', version: '0.1' });
    // Keys must be absent (not null/empty), so the API keeps the stored value.
    expect(Object.keys(res.definition).sort()).toEqual(['actorSpecification', 'name', 'version']);
    expect(JSON.parse(JSON.stringify(res.definition))).not.toHaveProperty('input');
    expect(JSON.parse(JSON.stringify(res.definition))).not.toHaveProperty('readme');
    expect(res.inputSource).toBe('none');
    expect(res.readmeSource).toBe('none');
    expect(res.warnings).toEqual([]);
  });

  it('treats input/readme null in actor.json as absent and omits the keys', async () => {
    const res = await resolveActorDefinitionWithSources(root, {
      ...BASE,
      input: null as unknown as string,
      readme: null as unknown as string,
    });
    expect(Object.keys(res.definition)).not.toContain('input');
    expect(Object.keys(res.definition)).not.toContain('readme');
  });

  it('passes every other actor.json field through unchanged', async () => {
    const extra = {
      title: 'My Actor',
      description: 'Does things',
      dockerfile: './Dockerfile',
      storages: { dataset: './dataset_schema.json' },
      environmentVariables: { MODE: 'fast' },
      defaultRunOptions: { build: 'latest', timeoutSecs: 60, memoryMbytes: 512 },
      minMemoryMbytes: 256,
    };
    await write('.actor/README.md', '# hi');
    const def = await resolve(root, { ...BASE, input: SCHEMA, ...extra });
    expect(def).toEqual({ ...BASE, ...extra, input: SCHEMA, readme: '# hi' });
  });

  it('does not mutate the actor.json object', async () => {
    const actorJson = { ...BASE, input: './input_schema.json' };
    await write('.actor/input_schema.json', SCHEMA);
    await resolve(root, actorJson);
    expect(actorJson.input).toBe('./input_schema.json');
  });

  it('fails, naming the limit, when the whole definition is over the 2 MB cap', async () => {
    const big = { ...BASE, description: 'x'.repeat(MAX_ACTOR_DEFINITION_BYTES) };
    await expect(resolve(root, big)).rejects.toThrow(
      new RegExp(`over the ${String(MAX_ACTOR_DEFINITION_BYTES)}-byte limit`)
    );
  });
});

describe('resolveActorDefinitionWithSources: input schema', () => {
  it('uses an inline object as is', async () => {
    const res = await resolveActorDefinitionWithSources(root, { ...BASE, input: SCHEMA });
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe('inline');
  });

  it('reads a string as a path relative to .actor/', async () => {
    await write('.actor/schemas/in.json', SCHEMA);
    const res = await resolveActorDefinitionWithSources(root, {
      ...BASE,
      input: './schemas/in.json',
    });
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe(path.join('.actor', 'schemas', 'in.json'));
  });

  it('resolves a path that points outside .actor/', async () => {
    await write('INPUT_SCHEMA.json', SCHEMA);
    const res = await resolveActorDefinitionWithSources(root, {
      ...BASE,
      input: '../INPUT_SCHEMA.json',
    });
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe('INPUT_SCHEMA.json');
  });

  it('resolves relative to actorDir, not process.cwd()', async () => {
    await write('.actor/input_schema.json', SCHEMA);
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const def = await resolve(root, { ...BASE, input: './input_schema.json' });
      expect(def.input).toEqual(SCHEMA);
    } finally {
      process.chdir(cwd);
    }
  });

  it('falls back to .actor/input_schema.json when input is absent', async () => {
    await write('.actor/input_schema.json', SCHEMA);
    await write('INPUT_SCHEMA.json', { ...SCHEMA, title: 'root' });
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe(path.join('.actor', 'input_schema.json'));
  });

  it('falls back to ./INPUT_SCHEMA.json when nothing exists under .actor/', async () => {
    await write('INPUT_SCHEMA.json', SCHEMA);
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe('INPUT_SCHEMA.json');
  });

  it('fails with the path when a referenced file is missing', async () => {
    const err = await resolve(root, { ...BASE, input: './nope.json' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorDefinitionError);
    expect((err as Error).message).toContain(path.join('.actor', 'nope.json'));
  });

  it('fails with the path and parse error on malformed JSON', async () => {
    await write('.actor/input_schema.json', '{ "type": "object", ');
    const err = await resolve(root, {
      ...BASE,
      input: './input_schema.json',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorDefinitionError);
    const msg = (err as Error).message;
    expect(msg).toContain(`Invalid JSON in ${path.join('.actor', 'input_schema.json')}`);
    expect(msg).toMatch(/JSON/);
  });

  it('warns and skips a malformed fallback file, omitting input', async () => {
    await write('INPUT_SCHEMA.json', 'not json');
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.inputSource).toBe('none');
    expect(Object.keys(res.definition)).not.toContain('input');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^Invalid JSON in INPUT_SCHEMA\.json: .* skipping it\.$/);
  });

  it('warns and skips a non-object fallback file', async () => {
    await write('INPUT_SCHEMA.json', '[1, 2]');
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(Object.keys(res.definition)).not.toContain('input');
    expect(res.warnings[0]).toMatch(/expected a JSON object/);
  });

  it('skips an unusable fallback and uses the next one', async () => {
    await write('.actor/input_schema.json', 'not json');
    await write('INPUT_SCHEMA.json', SCHEMA);
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.inputSource).toBe('INPUT_SCHEMA.json');
    // One warning per unusable file (two on case-insensitive filesystems,
    // where .actor/input_schema.json and .actor/INPUT_SCHEMA.json are the same file).
    expect(res.warnings.length).toBeGreaterThan(0);
    for (const w of res.warnings) expect(w).toMatch(/^Invalid JSON in \.actor\//);
  });

  it('rejects a referenced schema file that is not a JSON object', async () => {
    await write('.actor/input_schema.json', '[1, 2]');
    await expect(resolve(root, { ...BASE, input: './input_schema.json' })).rejects.toThrow(
      /expected a JSON object/
    );
  });

  it('rejects an input field that is neither a path nor an object', async () => {
    await expect(resolve(root, { ...BASE, input: 42 as unknown as string })).rejects.toThrow(
      '"input" must be an inline schema object or a path to a JSON file'
    );
  });

  it('rejects an empty input path with a clear message (not EISDIR)', async () => {
    await expect(resolve(root, { ...BASE, input: '' })).rejects.toThrow(
      '.actor/actor.json: "input" must not be an empty path'
    );
  });

  it('names a referenced directory clearly', async () => {
    await fs.ensureDir(path.join(root, '.actor', 'schemas'));
    await expect(resolve(root, { ...BASE, input: './schemas' })).rejects.toThrow(
      `Cannot read ${path.join('.actor', 'schemas')}: is a directory`
    );
  });

  it('accepts a UTF-8 BOM', async () => {
    await write('.actor/input_schema.json', '\uFEFF' + JSON.stringify(SCHEMA));
    const def = await resolve(root, BASE);
    expect(def.input).toEqual(SCHEMA);
  });

  it('warns when the schema lacks top-level type and properties, but still sends it', async () => {
    const res = await resolveActorDefinitionWithSources(root, {
      ...BASE,
      input: { title: 'x' },
    });
    expect(res.definition.input).toEqual({ title: 'x' });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/"type" and "properties"/);
  });

  it('fails, naming the source and the limit, on an input schema over the size limit', async () => {
    const big = { ...SCHEMA, description: 'x'.repeat(MAX_ACTOR_INPUT_SCHEMA_BYTES) };
    const err = await resolve(root, { ...BASE, input: big }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorDefinitionError);
    expect((err as Error).message).toMatch(
      /^Input schema \(inline\) is \d+ bytes, over the 512000-byte limit/
    );
  });

  it('fails, naming the file, on a schema file over the size limit', async () => {
    const big = { ...SCHEMA, description: 'x'.repeat(MAX_ACTOR_INPUT_SCHEMA_BYTES) };
    await write('.actor/input_schema.json', big);
    await expect(resolve(root, BASE)).rejects.toThrow(
      `Input schema (${path.join('.actor', 'input_schema.json')})`
    );
  });
});

describe('resolveActorDefinitionWithSources: README', () => {
  it('rejects a non-string readme field like a bad input', async () => {
    await write('README.md', '# from root');
    await expect(resolve(root, { ...BASE, readme: 123 as unknown as string })).rejects.toThrow(
      '.actor/actor.json: "readme" must be a path to a Markdown file'
    );
  });

  it('rejects an empty readme path with a clear message (not EISDIR)', async () => {
    await expect(resolve(root, { ...BASE, readme: '' })).rejects.toThrow(
      '.actor/actor.json: "readme" must not be an empty path'
    );
  });

  it('prefers the actor.json readme path (relative to .actor/)', async () => {
    await write('docs/README.md', '# from field');
    await write('.actor/README.md', '# from .actor');
    await write('README.md', '# from root');
    const res = await resolveActorDefinitionWithSources(root, {
      ...BASE,
      readme: '../docs/README.md',
    });
    expect(res.definition.readme).toBe('# from field');
    expect(res.readmeSource).toBe(path.join('docs', 'README.md'));
  });

  it('falls back to .actor/README.md before ./README.md', async () => {
    await write('.actor/README.md', '# from .actor');
    await write('README.md', '# from root');
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition.readme).toBe('# from .actor');
    expect(res.readmeSource).toBe(path.join('.actor', 'README.md'));
  });

  it('falls back to ./README.md', async () => {
    await write('README.md', '# from root');
    const def = await resolve(root, BASE);
    expect(def.readme).toBe('# from root');
  });

  it('fails with the path when the referenced readme is missing', async () => {
    await write('README.md', '# from root');
    await expect(resolve(root, { ...BASE, readme: './MISSING.md' })).rejects.toThrow(
      path.join('.actor', 'MISSING.md')
    );
  });

  it('fails, naming the file and the limit, on a README over the size limit', async () => {
    // Multi-byte characters: the cap is in UTF-8 bytes, not characters.
    await write('README.md', 'é'.repeat(MAX_ACTOR_README_BYTES / 2 + 1));
    const err = await resolve(root, { ...BASE, input: SCHEMA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorDefinitionError);
    expect((err as Error).message).toMatch(
      /^README \(README\.md\) is \d+ bytes, over the 1048576-byte limit/
    );
  });

  it('accepts a README of exactly the size limit', async () => {
    await write('README.md', 'x'.repeat(MAX_ACTOR_README_BYTES));
    const def = await resolve(root, BASE);
    expect(def.readme).toHaveLength(MAX_ACTOR_README_BYTES);
  });
});

describe('resolveActorDefinitionWithSources: MCP e2e fixture actor (#107)', () => {
  it('resolves the fixture input schema with required = ["query"] and its README', async () => {
    const fixtureDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../tests/mcp-e2e/fixture-actor'
    );
    const actorJson = (await fs.readJson(path.join(fixtureDir, '.actor', 'actor.json'))) as {
      input: string;
    };
    const res = await resolveActorDefinitionWithSources(fixtureDir, actorJson);
    expect(res.inputSource).toBe(path.join('.actor', 'input_schema.json'));
    expect(res.definition.name).toBe('echo-scraper');
    expect(res.definition.input?.type).toBe('object');
    expect(res.definition.input?.required).toEqual(['query']);
    expect(res.definition.readme).toBe(
      await fs.readFile(path.join(fixtureDir, 'README.md'), 'utf8')
    );
    expect(res.warnings).toEqual([]);
  });
});
