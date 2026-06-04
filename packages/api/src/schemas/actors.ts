import { z } from 'zod';

import { SUPPORTED_WEBHOOK_EVENTS } from './webhooks.js';

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
