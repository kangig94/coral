import { z } from 'zod';

import { identPattern, providerIdentPattern } from '../infra/identifiers.js';

const ownerSchema = z.string().regex(identPattern, 'Owner must be token-safe');
const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

export const workflowCommandSchema = z
  .object({
    expression: z.string().min(1, 'Expression required'),
    startPrompt: z.string().min(1, 'Prompt required'),
    context: z.string().optional(),
    provider: providerNameSchema.default('claude'),
    workDir: z.string().optional(),
    owner: ownerSchema.optional(),
  })
  .strict();

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;
