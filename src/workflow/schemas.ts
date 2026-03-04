import { z } from 'zod';
import { providerIdentPattern } from '../shared/mcp-utils.js';

const atomArgsSchema = z.record(z.string(), z.unknown());

export const workflowInputSchema = z.object({
  expression: z.string().min(1, 'Expression required'),
  prompt: z.string().min(1, 'Prompt required'),
  provider: z
    .string()
    .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens')
    .default('codex'),
  args: z.record(z.string(), atomArgsSchema).optional(),
}).superRefine((value, ctx) => {
  if (!value.args) return;
  for (const [atomName, atomArgs] of Object.entries(value.args)) {
    if (Object.prototype.hasOwnProperty.call(atomArgs, 'bypass')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Workflow v1 does not support args.<atom>.bypass',
        path: ['args', atomName, 'bypass'],
      });
    }
  }
});

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
