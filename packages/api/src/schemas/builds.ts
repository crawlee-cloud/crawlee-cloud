import { z } from 'zod';

/**
 * POST /v2/acts/:actorId/builds body. Every field is optional and the body
 * itself may be absent (apify-client's `actor.build()` sends its options as
 * query params, not a body), so the route parses `request.body ?? {}`.
 * Unknown keys are stripped.
 */
export const StartBuildSchema = z.object({
  versionId: z.string().min(1).max(64).nullish(),
  gitBranch: z.string().max(255).nullish(),
  gitCommit: z.string().max(255).nullish(),
});
