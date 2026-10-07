/**
 * Unit tests for `resolveActorDefinition` (#116): how `crc push` finds the
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
  resolveActorDefinition,
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

describe('resolveActorDefinition: identity fields', () => {
  it('copies actorSpecification, name and version and omits absent input/readme', async () => {
    const res = await resolveActorDefinitionWithSources(root, BASE);
    expect(res.definition).toEqual({ actorSpecification: 1, name: 'my-actor', version: '0.1' });
    expect(res.inputSource).toBe('none');
    expect(res.readmeSource).toBe('none');
    expect(res.warnings).toEqual([]);
  });
});

describe('resolveActorDefinition: input schema', () => {
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
      const def = await resolveActorDefinition(root, { ...BASE, input: './input_schema.json' });
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
    const err = await resolveActorDefinition(root, { ...BASE, input: './nope.json' }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ActorDefinitionError);
    expect((err as Error).message).toContain(path.join('.actor', 'nope.json'));
  });

  it('fails with the path and parse error on malformed JSON', async () => {
    await write('.actor/input_schema.json', '{ "type": "object", ');
    const err = await resolveActorDefinition(root, {
      ...BASE,
      input: './input_schema.json',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorDefinitionError);
    const msg = (err as Error).message;
    expect(msg).toContain(`Invalid JSON in ${path.join('.actor', 'input_schema.json')}`);
    expect(msg).toMatch(/JSON/);
  });

  it('fails on malformed JSON in a fallback file too', async () => {
    await write('.actor/input_schema.json', 'not json');
    await expect(resolveActorDefinition(root, BASE)).rejects.toThrow(/Invalid JSON in/);
  });

  it('rejects a schema file that is not a JSON object', async () => {
    await write('.actor/input_schema.json', '[1, 2]');
    await expect(resolveActorDefinition(root, BASE)).rejects.toThrow(/expected a JSON object/);
  });

  it('rejects an input field that is neither a path nor an object', async () => {
    await expect(
      resolveActorDefinition(root, { ...BASE, input: 42 as unknown as string })
    ).rejects.toBeInstanceOf(ActorDefinitionError);
  });

  it('accepts a UTF-8 BOM', async () => {
    await write('.actor/input_schema.json', '﻿' + JSON.stringify(SCHEMA));
    const def = await resolveActorDefinition(root, BASE);
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

  it('warns and skips an input schema over the size limit', async () => {
    const big = { ...SCHEMA, description: 'x'.repeat(MAX_ACTOR_INPUT_SCHEMA_BYTES) };
    const res = await resolveActorDefinitionWithSources(root, { ...BASE, input: big });
    expect(res.definition.input).toBeUndefined();
    expect(res.inputSource).toBe('none');
    expect(res.warnings[0]).toMatch(/over the 512000-byte limit/);
  });
});

describe('resolveActorDefinition: README', () => {
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
    const def = await resolveActorDefinition(root, BASE);
    expect(def.readme).toBe('# from root');
  });

  it('fails with the path when the referenced readme is missing', async () => {
    await write('README.md', '# from root');
    await expect(resolveActorDefinition(root, { ...BASE, readme: './MISSING.md' })).rejects.toThrow(
      path.join('.actor', 'MISSING.md')
    );
  });

  it('warns and skips a README over the size limit', async () => {
    // Multi-byte characters: the cap is in UTF-8 bytes, not characters.
    await write('README.md', 'é'.repeat(MAX_ACTOR_README_BYTES / 2 + 1));
    const res = await resolveActorDefinitionWithSources(root, { ...BASE, input: SCHEMA });
    expect(res.definition.readme).toBeUndefined();
    expect(res.definition.input).toEqual(SCHEMA);
    expect(res.readmeSource).toBe('none');
    expect(res.warnings[0]).toMatch(/README .* over the 1048576-byte limit/);
  });
});

describe('resolveActorDefinition: MCP e2e fixture actor (#107)', () => {
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
