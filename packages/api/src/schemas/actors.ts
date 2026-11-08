import { z } from 'zod';

import { SUPPORTED_WEBHOOK_EVENTS } from './webhooks.js';

// Size caps for the build's actorDefinition (#112). Measured in UTF-8 bytes
// of the serialized value so a multi-byte README can't slip past a
// character-count check. The whole definition is capped too, since unknown
// keys pass through and would otherwise only be bounded by the server's
// 10 MB bodyLimit.
export const MAX_ACTOR_INPUT_SCHEMA_BYTES = 500 * 1024;
export const MAX_ACTOR_README_BYTES = 1024 * 1024;
export const MAX_ACTOR_DEFINITION_BYTES = 2 * 1024 * 1024;

// No `u` flag: matches UTF-16 code units, so it finds a high surrogate not
// followed by a low one, or a low one not preceded by a high one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Path of the first string (value or object key) Postgres JSONB would refuse
 * to store — a NUL character or an unpaired surrogate — or undefined. Caught
 * here as a 400 instead of failing the build write after the actor update.
 */
function findJsonbUnsafeString(
  value: unknown,
  path: (string | number)[]
): (string | number)[] | undefined {
  const unsafe = (s: string) => s.includes('\u0000') || LONE_SURROGATE.test(s);
  if (typeof value === 'string') return unsafe(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findJsonbUnsafeString(value[i], [...path, i]);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (unsafe(key)) return [...path, key];
      const found = findJsonbUnsafeString(child, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Apify-shaped actor definition (`.actor/actor.json` with the input schema
 * and README inlined), stored per build on actor_builds.actor_definition.
 * `input` must be the schema object itself, not a file path — the Apify MCP
 * server only keeps it when it has both `type` and `properties`. Unknown
 * keys pass through so Apify fields like `dockerfile` and `storages` survive.
 * The input schema is stored as given, not validated against Apify's spec.
 */
export const ActorDefinitionSchema = z
  .object({
    actorSpecification: z.number().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    readme: z.string().optional(),
  })
  .passthrough()
  .superRefine((def, ctx) => {
    if (
      def.input !== undefined &&
      Buffer.byteLength(JSON.stringify(def.input)) > MAX_ACTOR_INPUT_SCHEMA_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input'],
        message: `actorDefinition.input must be at most ${MAX_ACTOR_INPUT_SCHEMA_BYTES} bytes serialized`,
      });
    }
    if (def.readme !== undefined && Buffer.byteLength(def.readme) > MAX_ACTOR_README_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readme'],
        message: `actorDefinition.readme must be at most ${MAX_ACTOR_README_BYTES} bytes`,
      });
    }
    const badPath = findJsonbUnsafeString(def, []);
    if (badPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: badPath,
        message:
          'actorDefinition must not contain NUL (\\u0000) characters or unpaired UTF-16 surrogates',
      });
    }
    if (Buffer.byteLength(JSON.stringify(def)) > MAX_ACTOR_DEFINITION_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `actorDefinition must be at most ${MAX_ACTOR_DEFINITION_BYTES} bytes serialized`,
      });
    }
  });

export type ActorDefinition = z.infer<typeof ActorDefinitionSchema>;

export const CreateActorSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      'Name must contain only letters, numbers, dots, dashes, and underscores'
    ),
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  defaultRunOptions: z
    .object({
      build: z.string().optional(),
      // Match the per-run caps in ActorRunSchema (timeout.max(86_400),
      // memory.max(16_384)). Previously these were uncapped on actor
      // create, and the fix that now propagates default_run_options to
      // runs would otherwise let an operator save an actor with e.g.
      // timeoutSecs: 200000 and bypass the run-time guardrail.
      timeoutSecs: z.number().int().positive().max(86_400).optional(),
      memoryMbytes: z.number().int().positive().max(16_384).optional(),
      // Full image reference written by `crc push` (e.g.
      // `ghcr.io/org/repo/actor-foo:latest`). When set, the runner uses
      // this exact value and skips registry-based path construction.
      image: z.string().min(1).optional(),
      // Per-actor env vars merged into every run's container environment.
      // Lower precedence than runtime `-e` overrides (which live in Redis
      // per-run); runtime overrides win on key conflict.
      envVars: z.record(z.string()).optional(),
    })
    .optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelaySecs: z.number().int().min(1).max(3600).optional(),
  proxyPassword: z.string().min(1).max(256).nullable().optional(),
  // Source version string from .actor/actor.json (e.g. "0.0", "1.2").
  // When provided, the API upserts an actor_versions row and links the
  // build to it — so /builds shows version history, not just image names.
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._+-]+$/, 'Version must be alphanumeric with . _ + -')
    .optional(),
  // Input schema, README and the rest of .actor/actor.json for this deploy.
  // Stored on the build row recordBuildIfNew writes or updates, so it
  // requires an image (no image → no build → 400).
  actorDefinition: ActorDefinitionSchema.optional(),
});

export const UpdateActorSchema = CreateActorSchema.partial();

export const RunWebhookSchema = z.object({
  eventTypes: z.array(z.enum(SUPPORTED_WEBHOOK_EVENTS)).min(1),
  requestUrl: z.string().url(),
  payloadTemplate: z.string().max(10_000).optional(),
  headersTemplate: z.string().max(10_000).optional(),
});

export const ActorRunSchema = z.object({
  input: z.unknown().optional(),
  timeout: z.number().int().positive().max(86_400).optional(), // Max 24h
  memory: z.number().int().positive().max(16_384).optional(), // Max 16GB
  envVars: z.record(z.string()).optional(),
  webhooks: z.array(RunWebhookSchema).max(20).optional(),
});

export const DeleteActorQuerySchema = z.object({
  force: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
});

export type DeleteActorQuery = z.infer<typeof DeleteActorQuerySchema>;
