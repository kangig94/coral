import { z } from 'zod';
import { providerIdentPattern } from '../shared/mcp-utils.js';
import { cwdSchema, effortSchema } from '../shared/schemas.js';

export const atomConfigSchema = z.object({
  effort: effortSchema,
  instruction: z.string().optional(),
}).strict();

export const workflowInputSchema = z.object({
  expression: z.string().min(1, 'Expression required'),
  prompt: z.string().min(1, 'Prompt required'),
  provider: z
    .string()
    .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens')
    .default('claude'),
  work_dir: cwdSchema,
  stale_timeout_seconds: z.number().min(0).default(900),
  atoms: z.record(z.string(), atomConfigSchema).optional(),
}).strict();

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
