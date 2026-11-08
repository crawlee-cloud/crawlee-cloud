/**
 * Resolves the Apify-style actor definition that `crc push` uploads as
 * `actorDefinition` (#116): the whole `.actor/actor.json` object, with the
 * input schema and README inlined the way the Apify CLI does it.
 *
 * The API stores it per build and the Apify MCP server builds its per-actor
 * tools from `actorDefinition.input`, so the input must be the schema object
 * itself, never a file path. When no schema (or README) is found the key is
 * left out entirely, never sent empty, so the API keeps the previous build's
 * value.
 */

import path from 'path';
import fs from 'fs-extra';

// Keep in sync with the API caps (packages/api/src/schemas/actors.ts). Over
// a limit the push fails before the Docker build: the API would 400 the
// definition anyway.
export const MAX_ACTOR_INPUT_SCHEMA_BYTES = 500 * 1024;
export const MAX_ACTOR_README_BYTES = 1024 * 1024;
export const MAX_ACTOR_DEFINITION_BYTES = 2 * 1024 * 1024;

/** The `.actor/actor.json` fields the resolver interprets; all others pass through. */
export interface ActorJsonDefinitionFields {
  actorSpecification?: number;
  name?: string;
  version?: string;
  // Inline schema object, or a path relative to `.actor/`.
  input?: string | Record<string, unknown>;
  // Path relative to `.actor/`.
  readme?: string;
}

/** `.actor/actor.json` with `input`/`readme` inlined; other fields pass through. */
export interface ActorDefinition {
  actorSpecification?: number;
  name?: string;
  version?: string;
  input?: Record<string, unknown>;
  readme?: string;
  [key: string]: unknown;
}

export interface ResolvedActorDefinition {
  definition: ActorDefinition;
  /** Where the input schema came from: a path relative to the actor root, "inline" or "none". */
  inputSource: string;
  /** Where the README came from: a path relative to the actor root, or "none". */
  readmeSource: string;
  /** Non-fatal problems (unusable fallback schema files, schema without type/properties). */
  warnings: string[];
}

/**
 * actor.json `input`/`readme` is invalid, a file it references is missing or
 * malformed, or the definition is over a size cap. Fails the push.
 */
export class ActorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorDefinitionError';
  }
}

const INPUT_SCHEMA_FALLBACKS = [
  '.actor/input_schema.json',
  '.actor/INPUT_SCHEMA.json',
  'INPUT_SCHEMA.json',
];
const README_FALLBACKS = ['.actor/README.md', 'README.md'];

/**
 * Resolve the actor definition for the actor rooted at `actorDir` (the
 * directory that contains `.actor/`). Paths are resolved against it, never
 * against `process.cwd()`.
 *
 * - Every actor.json field is copied as is (title, description, storages,
 *   environmentVariables, defaultRunOptions, dockerfile, ...).
 * - `input`: an inline object is used as is; a string is a path relative to
 *   `.actor/`; if absent, the first usable fallback file is used.
 * - `readme`: the `readme` path (relative to `.actor/`), else
 *   `.actor/README.md`, else `./README.md`.
 * - If no schema / README is found, that key is omitted.
 *
 * Throws an `ActorDefinitionError` when `input` is neither an object nor a
 * path, `readme` is not a string, a path is empty, a file referenced by
 * actor.json is missing or malformed, or a size cap is exceeded. Fallback
 * files are best-effort: missing ones are skipped silently, malformed or
 * non-object schemas are skipped with a warning.
 */
export async function resolveActorDefinitionWithSources(
  actorDir: string,
  actorJson: ActorJsonDefinitionFields
): Promise<ResolvedActorDefinition> {
  const warnings: string[] = [];
  const {
    input: rawInput,
    readme: rawReadme,
    ...rest
  } = actorJson as ActorJsonDefinitionFields & Record<string, unknown>;
  const definition: ActorDefinition = { ...rest };

  // ---- input schema ----
  let input: Record<string, unknown> | undefined;
  let inputSource = 'none';
  if (rawInput !== undefined && rawInput !== null) {
    if (typeof rawInput === 'string') {
      const file = resolveReferencedPath(actorDir, 'input', rawInput);
      input = await readJsonObject(file, actorDir);
      inputSource = displayPath(actorDir, file);
    } else if (isPlainObject(rawInput)) {
      input = rawInput;
      inputSource = 'inline';
    } else {
      throw new ActorDefinitionError(
        '.actor/actor.json: "input" must be an inline schema object or a path to a JSON file'
      );
    }
  } else {
    for (const rel of INPUT_SCHEMA_FALLBACKS) {
      const file = path.join(actorDir, rel);
      try {
        const found = await readJsonObject(file, actorDir, { optional: true });
        if (found) {
          input = found;
          inputSource = displayPath(actorDir, file);
          break;
        }
      } catch (err) {
        if (!(err instanceof ActorDefinitionError)) throw err;
        warnings.push(`${err.message} - skipping it.`);
      }
    }
  }

  if (input) {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > MAX_ACTOR_INPUT_SCHEMA_BYTES) {
      throw new ActorDefinitionError(
        `Input schema (${inputSource}) is ${String(bytes)} bytes, over the ${String(MAX_ACTOR_INPUT_SCHEMA_BYTES)}-byte limit.`
      );
    }
    if (!('type' in input) || !('properties' in input)) {
      warnings.push(
        `Input schema (${inputSource}) has no top-level "type" and "properties"; MCP clients will ignore it.`
      );
    }
    definition.input = input;
  }

  // ---- README ----
  let readmeSource = 'none';
  let readme: string | undefined;
  if (rawReadme !== undefined && rawReadme !== null) {
    if (typeof rawReadme !== 'string') {
      throw new ActorDefinitionError(
        '.actor/actor.json: "readme" must be a path to a Markdown file'
      );
    }
    const file = resolveReferencedPath(actorDir, 'readme', rawReadme);
    readme = await readText(file, actorDir);
    readmeSource = displayPath(actorDir, file);
  } else {
    for (const rel of README_FALLBACKS) {
      const file = path.join(actorDir, rel);
      const found = await readText(file, actorDir, { optional: true });
      if (found !== undefined) {
        readme = found;
        readmeSource = displayPath(actorDir, file);
        break;
      }
    }
  }

  if (readme !== undefined) {
    const bytes = Buffer.byteLength(readme);
    if (bytes > MAX_ACTOR_README_BYTES) {
      throw new ActorDefinitionError(
        `README (${readmeSource}) is ${String(bytes)} bytes, over the ${String(MAX_ACTOR_README_BYTES)}-byte limit.`
      );
    }
    definition.readme = readme;
  }

  const totalBytes = Buffer.byteLength(JSON.stringify(definition));
  if (totalBytes > MAX_ACTOR_DEFINITION_BYTES) {
    throw new ActorDefinitionError(
      `Actor definition (.actor/actor.json with the input schema and README inlined) is ${String(totalBytes)} bytes, over the ${String(MAX_ACTOR_DEFINITION_BYTES)}-byte limit.`
    );
  }

  return { definition, inputSource, readmeSource, warnings };
}

// ---- Helpers ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayPath(actorDir: string, file: string): string {
  const rel = path.relative(actorDir, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

function resolveReferencedPath(actorDir: string, field: string, value: string): string {
  if (value.trim() === '') {
    throw new ActorDefinitionError(`.actor/actor.json: "${field}" must not be an empty path`);
  }
  return path.resolve(actorDir, '.actor', value);
}

/**
 * Read a text file. With `optional`, a missing file (or a directory) yields
 * `undefined`; otherwise any read error throws an `ActorDefinitionError`.
 */
async function readText(
  file: string,
  actorDir: string,
  opts: { optional?: boolean } = {}
): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.optional && (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR')) {
      return undefined;
    }
    const reason =
      code === 'ENOENT'
        ? 'file not found'
        : code === 'EISDIR'
          ? 'is a directory'
          : (err as Error).message;
    throw new ActorDefinitionError(`Cannot read ${displayPath(actorDir, file)}: ${reason}`);
  }
}

async function readJsonObject(
  file: string,
  actorDir: string,
  opts: { optional?: boolean } = {}
): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file, actorDir, opts);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    // Strip a UTF-8 BOM, which some editors write and JSON.parse rejects.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ActorDefinitionError(
      `Invalid JSON in ${displayPath(actorDir, file)}: ${(err as Error).message}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ActorDefinitionError(
      `Invalid input schema in ${displayPath(actorDir, file)}: expected a JSON object`
    );
  }
  return parsed;
}
