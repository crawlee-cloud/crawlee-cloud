/**
 * Unit tests for the pure helpers behind `crc push`: actor.json
 * validation, --env collection, .env file parsing, and the env-merge
 * precedence (actor.json < --env-file < --env).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { validateActorJson, collectEnv, loadEnvFile, dropEmpty } from '../src/commands/push.js';

describe('validateActorJson', () => {
  const valid = { actorSpecification: 1, name: 'my-actor', version: '0.1' };

  it('accepts a well-formed actor.json', () => {
    expect(validateActorJson(valid)).toEqual([]);
  });

  it('requires a name', () => {
    expect(validateActorJson({ ...valid, name: undefined as unknown as string })).toEqual([
      'Missing required field: "name"',
    ]);
  });

  it.each(['My-Actor', 'actor_underscore', 'actor.dot', 'actor space', 'ümlaut'])(
    'rejects the invalid name %j',
    (name) => {
      const errors = validateActorJson({ ...valid, name });
      expect(errors).toEqual(['"name" must contain only lowercase letters, numbers, and hyphens']);
    }
  );

  it('accepts lowercase letters, numbers, and hyphens', () => {
    expect(validateActorJson({ ...valid, name: 'actor-2-scraper' })).toEqual([]);
  });

  it('requires actorSpecification', () => {
    const errors = validateActorJson({
      ...valid,
      actorSpecification: undefined as unknown as number,
    });
    expect(errors).toEqual(['Missing required field: "actorSpecification"']);
  });

  it('accumulates multiple findings', () => {
    expect(validateActorJson({} as never)).toHaveLength(2);
  });
});

describe('collectEnv', () => {
  it('accumulates repeated KEY=VALUE pairs', () => {
    const one = collectEnv('A=1', {});
    const two = collectEnv('B=two', one);
    expect(two).toEqual({ A: '1', B: 'two' });
  });

  it('keeps equals signs inside the value', () => {
    expect(collectEnv('URL=https://x.test/?a=b&c=d', {})).toEqual({
      URL: 'https://x.test/?a=b&c=d',
    });
  });

  it('allows an empty value', () => {
    expect(collectEnv('EMPTY=', {})).toEqual({ EMPTY: '' });
  });

  it.each(['NOVALUE', '=starts-with-eq', ''])('throws on malformed input %j', (arg) => {
    expect(() => collectEnv(arg, {})).toThrow(/Expected KEY=VALUE/);
  });
});

describe('loadEnvFile', () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpFiles.splice(0).map((f) => fs.remove(f)));
  });

  async function writeEnvFile(content: string): Promise<string> {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'crc-envfile-')), '.env');
    await fs.writeFile(file, content);
    tmpFiles.push(path.dirname(file));
    return file;
  }

  it('parses assignments, skipping comments and blank lines', async () => {
    const file = await writeEnvFile(
      ['# a comment', '', 'PLAIN=value', '  SPACED = padded ', 'MISSING_EQ', '=no-key'].join('\n')
    );

    expect(await loadEnvFile(file)).toEqual({ PLAIN: 'value', SPACED: 'padded' });
  });

  it('strips matching single and double quotes', async () => {
    const file = await writeEnvFile(
      ['DQ="double quoted"', "SQ='single quoted'", 'MIXED="keep\'em"'].join('\n')
    );

    expect(await loadEnvFile(file)).toEqual({
      DQ: 'double quoted',
      SQ: 'single quoted',
      MIXED: "keep'em",
    });
  });

  it('does not interpolate shell variables', async () => {
    const file = await writeEnvFile('REF=$HOME/sub');
    expect(await loadEnvFile(file)).toEqual({ REF: '$HOME/sub' });
  });

  it('rejects a missing file', async () => {
    await expect(loadEnvFile('/nonexistent/.env')).rejects.toThrow();
  });
});

describe('dropEmpty', () => {
  it('drops undefined and empty-string values', () => {
    expect(dropEmpty({ KEEP: 'x', EMPTY: '', GONE: undefined, ZERO: '0' })).toEqual({
      KEEP: 'x',
      ZERO: '0',
    });
  });
});

describe('env-merge precedence (actor.json < --env-file < --env)', () => {
  it('later sources override earlier ones, empties dropped', () => {
    const actorJsonEnv = { FROM_ACTOR: 'actor', SHARED: 'actor' };
    const envFile = dropEmpty({ SHARED: 'file', FILE_ONLY: 'file', DROPPED: '' });
    const cliFlags = dropEmpty(collectEnv('SHARED=cli', {}));

    // Mirrors the merge in push.ts: base < env-file < -e flags.
    const merged = { ...actorJsonEnv, ...envFile, ...cliFlags };

    expect(merged).toEqual({
      FROM_ACTOR: 'actor',
      FILE_ONLY: 'file',
      SHARED: 'cli',
    });
  });
});
