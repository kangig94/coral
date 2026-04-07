import { z } from 'zod';
import { identPattern, providerIdentPattern } from '../shared/utils.js';
import { cwdSchema } from '../shared/schemas.js';

export const workflowInputSchema = z
  .object({
    expression: z.string().min(1, 'Expression required'),
    start_prompt: z.string().min(1, 'Prompt required'),
    context: z.string().optional(),
    provider: z
      .string()
      .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens')
      .default('claude'),
    work_dir: cwdSchema,
    owner: z.string().regex(identPattern, 'Owner must be token-safe').optional(),
  })
  .strict();

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
