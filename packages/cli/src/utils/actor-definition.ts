/**
 * Resolves the Apify-style actor definition that `crc push` uploads as
 * `actorDefinition` (#116): the `.actor/actor.json` identity fields plus the
 * input schema and README inlined, the way the Apify CLI does it.
 *
 * The API stores it per build and the Apify MCP server builds its per-actor
 * tools from `actorDefinition.input`, so the input must be the schema object
 * itself, never a file path.
 */

import path from 'path';
import fs from 'fs-extra';

// Keep in sync with the API caps (packages/api/src/schemas/actors.ts). Over
// the limit we warn and skip the field rather than letting the API 400 the
// whole push.
export const MAX_ACTOR_INPUT_SCHEMA_BYTES = 500 * 1024;
export const MAX_ACTOR_README_BYTES = 1024 * 1024;

/** The subset of `.actor/actor.json` the resolver reads. */
export interface ActorJsonDefinitionFields {
  actorSpecification?: number;
  name?: string;
  version?: string;
  // Inline schema object, or a path relative to `.actor/`.
  input?: string | Record<string, unknown>;
  // Path relative to `.actor/`.
  readme?: string;
}

export interface ActorDefinition {
  actorSpecification?: number;
  name?: string;
  version?: string;
  input?: Record<string, unknown>;
  readme?: string;
}

export interface ResolvedActorDefinition {
  definition: ActorDefinition;
  /** Where the input schema came from: a path relative to the actor root, "inline" or "none". */
  inputSource: string;
  /** Where the README came from: a path relative to the actor root, or "none". */
  readmeSource: string;
  /** Non-fatal problems (oversize fields, schema without type/properties). */
  warnings: string[];
}

/** A referenced file is missing or holds malformed JSON. Fails the push. */
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
 * - `input`: an inline object is used as is; a string is a path relative to
 *   `.actor/`; if absent, the first existing fallback file is used.
 * - `readme`: the `readme` path (relative to `.actor/`), else
 *   `.actor/README.md`, else `./README.md`.
 *
 * Missing fallback files are skipped silently. A referenced file that is
 * missing, or malformed JSON, throws an `ActorDefinitionError` naming the
 * file. Oversize fields are dropped with a warning.
 */
export async function resolveActorDefinitionWithSources(
  actorDir: string,
  actorJson: ActorJsonDefinitionFields
): Promise<ResolvedActorDefinition> {
  const warnings: string[] = [];
  const definition: ActorDefinition = {
    actorSpecification: actorJson.actorSpecification,
    name: actorJson.name,
    version: actorJson.version,
  };

  // ---- input schema ----
  let input: Record<string, unknown> | undefined;
  let inputSource = 'none';
  if (actorJson.input !== undefined && actorJson.input !== null) {
    if (typeof actorJson.input === 'string') {
      const file = path.resolve(actorDir, '.actor', actorJson.input);
      input = await readJsonObject(file, actorDir, true);
      inputSource = displayPath(actorDir, file);
    } else if (isPlainObject(actorJson.input)) {
      input = actorJson.input;
      inputSource = 'inline';
    } else {
      throw new ActorDefinitionError(
        '.actor/actor.json: "input" must be an inline schema object or a path to a JSON file'
      );
    }
  } else {
    for (const rel of INPUT_SCHEMA_FALLBACKS) {
      const file = path.join(actorDir, rel);
      const found = await readJsonObject(file, actorDir, false);
      if (found) {
        input = found;
        inputSource = displayPath(actorDir, file);
        break;
      }
    }
  }

  if (input) {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > MAX_ACTOR_INPUT_SCHEMA_BYTES) {
      warnings.push(
        `Input schema (${inputSource}) is ${String(bytes)} bytes, over the ${String(MAX_ACTOR_INPUT_SCHEMA_BYTES)}-byte limit; not uploading it.`
      );
      inputSource = 'none';
    } else {
      if (!('type' in input) || !('properties' in input)) {
        warnings.push(
          `Input schema (${inputSource}) has no top-level "type" and "properties"; MCP clients will ignore it.`
        );
      }
      definition.input = input;
    }
  }

  // ---- README ----
  let readmeSource = 'none';
  let readme: string | undefined;
  if (typeof actorJson.readme === 'string') {
    const file = path.resolve(actorDir, '.actor', actorJson.readme);
    readme = await readText(file, actorDir, true);
    readmeSource = displayPath(actorDir, file);
  } else {
    for (const rel of README_FALLBACKS) {
      const file = path.join(actorDir, rel);
      const found = await readText(file, actorDir, false);
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
      warnings.push(
        `README (${readmeSource}) is ${String(bytes)} bytes, over the ${String(MAX_ACTOR_README_BYTES)}-byte limit; not uploading it.`
      );
      readmeSource = 'none';
    } else {
      definition.readme = readme;
    }
  }

  return { definition, inputSource, readmeSource, warnings };
}

/** `resolveActorDefinitionWithSources` without the source/warning details. */
export async function resolveActorDefinition(
  actorDir: string,
  actorJson: ActorJsonDefinitionFields
): Promise<ActorDefinition> {
  return (await resolveActorDefinitionWithSources(actorDir, actorJson)).definition;
}

// ---- Helpers ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayPath(actorDir: string, file: string): string {
  const rel = path.relative(actorDir, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

async function readText(
  file: string,
  actorDir: string,
  required: boolean
): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!required && (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR')) {
      return undefined;
    }
    throw new ActorDefinitionError(
      `Cannot read ${displayPath(actorDir, file)}: ${(err as Error).message}`
    );
  }
}

async function readJsonObject(
  file: string,
  actorDir: string,
  required: boolean
): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file, actorDir, required);
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
