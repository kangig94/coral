import { z } from 'zod';

export const waitInputSchema = z
  .object({
    jobs: z.array(z.string()).min(1, 'At least one job required'),
    timeout_seconds: z.number().min(1).max(1200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type WaitInput = z.infer<typeof waitInputSchema>;

export const abortInputSchema = z.object({
  jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
});

export type AbortInput = z.infer<typeof abortInputSchema>;
