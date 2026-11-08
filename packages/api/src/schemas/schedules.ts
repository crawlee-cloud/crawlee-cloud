import { z } from 'zod';
import { USERNAME_MAX_LENGTH } from '../auth/username.js';

const cronRegex = /^(\S+\s+){4}\S+$/;

/**
 * `actorId` takes any form resolveActor accepts (id, name, `username~name`,
 * `username/name`), so it must fit the longest: username + separator + actor
 * name (CreateActorSchema caps names at 100).
 */
const ACTOR_REF_MAX_LENGTH = USERNAME_MAX_LENGTH + 1 + 100;

export const CreateScheduleSchema = z.object({
  actorId: z.string().min(1).max(ACTOR_REF_MAX_LENGTH),
  name: z.string().min(1).max(200),
  cronExpression: z.string().regex(cronRegex, 'Must be a valid 5-field cron expression'),
  timezone: z.string().max(50).optional(),
  isEnabled: z.boolean().optional(),
  input: z.unknown().optional(),
});

export const UpdateScheduleSchema = CreateScheduleSchema.partial();
