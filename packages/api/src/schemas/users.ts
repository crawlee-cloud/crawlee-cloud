import { z } from 'zod';

export const UpdateUserSchema = z.object({
  proxyPassword: z.string().min(1).max(256).nullable().optional(),
});
