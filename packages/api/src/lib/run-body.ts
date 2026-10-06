/**
 * Request parsing for `POST /v2/acts/:actorId/runs` (and run-sync, which
 * forwards to it).
 *
 * Apify contract: the request body IS the actor input, and run options go in
 * the query string (`timeout`, `memory`, `waitForFinish`, base64 `webhooks`,
 * ...). That is what `apify-client`'s `actor.start(input)` / `call(input)`
 * send.
 *
 * Legacy contract (our CLI and dashboard before #118): a wrapper body
 * `{ input, timeout, memory, envVars, webhooks }`. It is detected explicitly
 * by `isLegacyRunBody` and kept working until 1.0. Known ambiguity: an input
 * that is genuinely `{ "input": ... }`, or made only of option-named keys
 * with legacy types (e.g. `{ "timeout": 60 }`), is read as legacy.
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
 * `application/x-www-form-urlencoded` stays accepted: `apify-client` sends
 * it with an empty body for `start()` without input, and the global parser
 * turns that into `{}`. Types without a parser already get Fastify's 415.
 */
const UNSUPPORTED_RUN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'application/octet-stream',
]);

export function isUnsupportedRunContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
  return UNSUPPORTED_RUN_CONTENT_TYPES.has(mediaType);
}

export interface RunStartRequest {
  /** Which contract the request used; legacy is logged for deprecation tracking. */
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
 * Legacy: options come from the body exactly as before; only `waitForFinish`
 * is read from the query. Apify: the whole body is the input (no body → `{}`;
 * non-object JSON is kept as given) and options come only from the query, so
 * input keys named `timeout` / `envVars` / ... are never treated as options.
 */
export function parseRunStartRequest(body: unknown, query: unknown): RunStartRequest {
  const waitForFinish = parseWaitForFinish(query);

  if (isLegacyRunBody(body)) {
    const parsed = ActorRunSchema.parse(body);
    return {
      legacy: true,
      input: parsed.input ?? {},
      timeout: parsed.timeout,
      memory: parsed.memory,
      envVars: parsed.envVars,
      webhooks: parsed.webhooks,
      waitForFinish,
    };
  }

  const options = ActorRunQuerySchema.parse(query ?? {});
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
