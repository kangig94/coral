import { z } from 'zod';
import { identPattern, providerIdentPattern } from './mcp-utils.js';

export const modelSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores')
  .optional();

export const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(identPattern, 'Session name must be alphanumeric (with . _ - allowed)');

export const promptSchema = z.string().min(1, 'Prompt is required');

export const sessionRefSchema = z.string().min(1, 'Session reference is required');

export const cwdSchema = z.string().optional();

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh']).optional();

export type EffortLevel = z.infer<typeof effortSchema>;

export const CORAL_DEFAULT_EFFORT = 'xhigh' as const;

export const coralOpSchema = z
  .string()
  .regex(
    /^coral:[a-z0-9][a-z0-9-]*$/,
    'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)',
  );

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

// ── Provider-neutral op schemas (Phase 1 additions) ──────────────────────────

/**
 * Shared exec input schema (provider-neutral).
 * Providers extend this with extras (e.g. system_prompt for Claude).
 */
export const sharedExecSchema = z.object({
  op: z.literal('exec'),
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  work_dir: cwdSchema,
});

/**
 * Shared resume input schema (explicit resume action, separate from exec).
 */
export const sharedResumeSchema = z.object({
  op: z.literal('resume'),
  session: sessionRefSchema,
  prompt: promptSchema,
  work_dir: cwdSchema,
});

/**
 * Shared fork input schema (provider-neutral).
 */
export const sharedForkSchema = z.object({
  op: z.literal('fork'),
  session: sessionRefSchema,
  prompt: z.string().optional(),
  work_dir: cwdSchema,
});

/**
 * Shared list input schema (no fields required).
 */
export const sharedListSchema = z.object({
  op: z.literal('list'),
}).strict();

/**
 * Wait tool input schema — accepts a list of jobIds to monitor.
 */
export const waitInputSchema = z.object({
  jobs: z.array(z.string()).min(1, 'At least one job required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
  cursor: z.string().min(1).optional(),
  inline: z.boolean().default(false),
}).strict();

export type WaitInput = z.infer<typeof waitInputSchema>;

/**
 * Abort tool input schema — accepts a list of jobIds to abort.
 */
export const abortInputSchema = z.object({
  jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
});

export type AbortInput = z.infer<typeof abortInputSchema>;
