import { z } from 'zod';

// Webhook event types Crawlee Cloud actually fires. Apify defines two more
// (ACTOR.RUN.CREATED, ACTOR.RUN.RESURRECTED) that we don't yet emit; rejecting
// subscriptions to them at submit-time is louder than accepting rows that
// silently never deliver. See docs/apify-compatibility.md for the gap row.
export const SUPPORTED_WEBHOOK_EVENTS = [
  'ACTOR.RUN.SUCCEEDED',
  'ACTOR.RUN.FAILED',
  'ACTOR.RUN.TIMED_OUT',
  'ACTOR.RUN.ABORTED',
] as const;

// Apify scopes a webhook with `condition`: exactly one of an actor, a task or
// a single run. `actorId` accepts every form the actor routes accept (id,
// name, `username~name`). Tasks don't exist here yet, so `actorTaskId` is
// rejected in the route rather than stored as a webhook that never fires.
export const WebhookConditionSchema = z
  .object({
    actorId: z.string().min(1).max(256).optional(),
    actorTaskId: z.string().min(1).max(256).optional(),
    actorRunId: z.string().min(1).max(256).optional(),
  })
  .refine(
    (c) => [c.actorId, c.actorTaskId, c.actorRunId].filter((v) => v !== undefined).length === 1,
    { message: 'condition must have exactly one of actorId, actorTaskId, actorRunId' }
  );

export const CreateWebhookSchema = z.object({
  eventTypes: z.array(z.enum(SUPPORTED_WEBHOOK_EVENTS)).min(1),
  requestUrl: z.string().url(),
  payloadTemplate: z.string().max(10000).optional(),
  // Crawlee Cloud extension, kept for the dashboard and existing callers:
  // a top-level actor id. Apify clients send `condition` instead.
  actorId: z.string().max(21).optional(),
  condition: WebhookConditionSchema.optional(),
  headers: z.record(z.string()).optional(),
  // Apify shape: headers as a JSON-string object. Used when `headers` is
  // absent; delivered statically, like per-run webhooks (no {{var}} templating).
  headersTemplate: z.string().max(10_000).optional(),
  description: z.string().max(1000).optional(),
  isEnabled: z.boolean().optional(),
  // Sent by apify-client / Actor.addWebhook(); accepted and ignored for now
  // (see docs/apify-compatibility.md).
  isAdHoc: z.boolean().optional(),
  idempotencyKey: z.string().max(256).optional(),
  ignoreSslErrors: z.boolean().optional(),
  doNotRetry: z.boolean().optional(),
  shouldInterpolateStrings: z.boolean().optional(),
});

export const UpdateWebhookSchema = CreateWebhookSchema.partial();
