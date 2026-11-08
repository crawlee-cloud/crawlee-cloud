import { z } from 'zod';

export const CreateVersionSchema = z.object({
  versionNumber: z.string().min(1).max(100),
  sourceType: z.string().max(50).nullish(),
  sourceUrl: z.string().max(2048).nullish(),
  dockerfile: z.string().max(1_000_000).nullish(),
  buildTag: z.string().max(100).nullish(),
  envVars: z.record(z.string()).nullish(),
});

export const CreateBuildSchema = z.object({
  versionId: z.string().min(1).max(256).nullish(),
  gitBranch: z.string().max(255).nullish(),
  gitCommit: z.string().max(255).nullish(),
});
