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

export const CreateWebhookSchema = z.object({
  eventTypes: z.array(z.enum(SUPPORTED_WEBHOOK_EVENTS)).min(1),
  requestUrl: z.string().url(),
  payloadTemplate: z.string().max(10000).optional(),
  actorId: z.string().max(21).optional(),
  headers: z.record(z.string()).optional(),
  description: z.string().max(1000).optional(),
  isEnabled: z.boolean().optional(),
});

export const UpdateWebhookSchema = CreateWebhookSchema.partial();
