/**
 * Request parsing for `POST /v2/acts/:actorId/runs` (and run-sync, which
 * forwards to it).
 *
 * Apify contract: the request body IS the actor input, and run options go in
 * the query string (`timeout`, `memory`, `waitForFinish`, base64 `webhooks`,
 * ...). That is what `apify-client`'s `actor.start(input)` / `call(input)`
 * send.
 *
 * Legacy wrapper (our CLI and dashboard before #118), a permanent,
 * documented Crawlee Cloud extension: a plain object
 * with an `input` key and otherwise only the option keys `timeout`,
 * `memory`, `envVars`, `webhooks`. It is detected explicitly by
 * `isLegacyRunBody`. For the pre-#118 dashboard, a body made only of option
 * keys with option value types (`{"timeout":3600,"memory":1024}`) is also
 * read as the wrapper, with input `{}`. Known ambiguity: an Apify-style input
 * that is genuinely `{ "input": ... }` (plus only option keys), or made only
 * of option-named keys with option types (e.g. `{ "timeout": 60 }`), is read
 * as the wrapper — clients send such input wrapped, `{ "input": <input> }`.
 */

import type { z } from 'zod';
import { ActorRunQuerySchema, ActorRunSchema, type RunWebhookSchema } from '../schemas/actors.js';
import { parseWaitForFinish } from './wait-for-terminal.js';

const LEGACY_KEYS: ReadonlySet<string> = new Set([
  'input',
  'timeout',
  'memory',
  'envVars',
  'webhooks',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasLegacyType(key: string, value: unknown): boolean {
  switch (key) {
    case 'timeout':
    case 'memory':
      return Number.isInteger(value);
    case 'envVars':
      return isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');
    case 'webhooks':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * True iff `body` is the legacy wrapper: a plain, non-empty object whose
 * keys are all in {input, timeout, memory, envVars, webhooks}, and that
 * either has an `input` key or has only option keys with the legacy value
 * types (the dashboard's empty-input body `{"timeout":3600,"memory":1024}`).
 */
export function isLegacyRunBody(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const keys = Object.keys(body);
  if (keys.length === 0 || !keys.every((k) => LEGACY_KEYS.has(k))) return false;
  if (keys.includes('input')) return true;
  return keys.every((k) => hasLegacyType(k, body[k]));
}

/**
 * Body content types this route refuses with 415. The global parsers turn
 * `text/plain` / `application/octet-stream` into a Buffer for other routes
 * (KV record uploads, ...); here that used to start a run with input `{}`.
 * An empty `application/x-www-form-urlencoded` body stays accepted:
 * `apify-client` sends it for `start()` without input, and the global parser
 * turns it into `{}`. A non-empty one is refused, see
 * `unsupportedRunBodyMessage`. Types without a parser already get Fastify's
 * 415.
 */
const UNSUPPORTED_RUN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'application/octet-stream',
]);

function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]!.trim().toLowerCase();
}

export function isUnsupportedRunContentType(contentType: string | undefined): boolean {
  const mediaType = mediaTypeOf(contentType);
  return mediaType !== undefined && UNSUPPORTED_RUN_CONTENT_TYPES.has(mediaType);
}

/**
 * True for a non-empty `application/x-www-form-urlencoded` body (the global
 * parser leaves it as the raw string; an empty one becomes `{}`). `curl -d
 * '{"query":"x"}'` sends exactly that: storing it as the JSON string INPUT
 * would hand the actor a string instead of the object it expects, so the
 * route refuses it with a hint to send `Content-Type: application/json`.
 */
export function isNonEmptyFormBody(contentType: string | undefined, body: unknown): boolean {
  return (
    mediaTypeOf(contentType) === 'application/x-www-form-urlencoded' &&
    typeof body === 'string' &&
    body.length > 0
  );
}

/** 415 message for a run-start body, or null when the body is accepted. */
export function unsupportedRunBodyMessage(
  contentType: string | undefined,
  body: unknown
): string | null {
  if (isUnsupportedRunContentType(contentType)) {
    return 'Run input must be sent as application/json';
  }
  if (isNonEmptyFormBody(contentType, body)) {
    return 'Run input must be sent as JSON with Content-Type: application/json (form-urlencoded bodies are not accepted; send run options in the query string)';
  }
  return null;
}

export interface RunStartRequest {
  /** Which contract the request used; legacy requests are logged (`run-body: legacy`). */
  legacy: boolean;
  /** Stored as the run's INPUT record (JSON). */
  input: unknown;
  timeout?: number;
  memory?: number;
  envVars?: Record<string, string>;
  webhooks?: Array<z.infer<typeof RunWebhookSchema>>;
  /** Seconds to hold the response until the run is terminal (0 = don't wait). */
  waitForFinish: number;
}

/**
 * Resolves input and run options from the body and query string. Throws a
 * ZodError (→ 400 `validation_error`) on invalid options.
 *
 * Legacy: options come from the body; a query option (`?timeout=`, ...)
 * applies when the wrapper lacks that field (the wrapper wins on conflict). Apify: the whole body is the input (no body → `{}`;
 * non-object JSON is kept as given) and options come only from the query, so
 * input keys named `timeout` / `envVars` / ... are never treated as options.
 */
export function parseRunStartRequest(body: unknown, query: unknown): RunStartRequest {
  const waitForFinish = parseWaitForFinish(query);

  const options = ActorRunQuerySchema.parse(query ?? {});

  if (isLegacyRunBody(body)) {
    const parsed = ActorRunSchema.parse(body);
    return {
      legacy: true,
      input: parsed.input ?? {},
      timeout: parsed.timeout ?? options.timeout,
      memory: parsed.memory ?? options.memory,
      envVars: parsed.envVars ?? options.envVars,
      webhooks: parsed.webhooks ?? options.webhooks,
      waitForFinish,
    };
  }

  return {
    legacy: false,
    input: body === undefined ? {} : body,
    timeout: options.timeout,
    memory: options.memory,
    envVars: options.envVars,
    webhooks: options.webhooks,
    waitForFinish,
  };
}
