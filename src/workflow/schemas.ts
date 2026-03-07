import { z } from 'zod';
import { providerIdentPattern } from '../shared/mcp-utils.js';

export const atomConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  instruction: z.string().optional(),
}).strict();

export const workflowInputSchema = z.object({
  expression: z.string().min(1, 'Expression required'),
  prompt: z.string().min(1, 'Prompt required'),
  provider: z
    .string()
    .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens')
    .default('claude'),
  stale_timeout_seconds: z.number().min(0).default(900),
  atoms: z.record(z.string(), atomConfigSchema).optional(),
}).strict();

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
