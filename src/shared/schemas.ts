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

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

export const coralOpSchema = z
  .string()
  .regex(
    /^coral:[a-z0-9][a-z0-9-]*$/,
    'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)',
  );

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

const sharedProviderFieldsShape = {
  work_dir: cwdSchema,
  model: modelSchema,
  bypass_permissions: z.boolean().optional(),
  system_prompt: z.string().optional(),
};

// ── Provider-neutral op schemas (Phase 1 additions) ──────────────────────────

/**
 * Shared exec input schema (provider-neutral).
 * Providers extend this with extras (e.g. system_prompt for Claude).
 */
export const sharedExecSchema = z.object({
  op: z.enum(['exec', 'bypass_exec']),
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  ...sharedProviderFieldsShape,
});

/**
 * Shared resume input schema (explicit resume action, separate from exec).
 */
export const sharedResumeSchema = z.object({
  op: z.literal('resume'),
  session: sessionRefSchema,
  prompt: promptSchema,
  ...sharedProviderFieldsShape,
});

/**
 * Shared fork input schema (provider-neutral).
 */
export const sharedForkSchema = z.object({
  op: z.literal('fork'),
  session: sessionRefSchema,
  prompt: z.string().optional(),
  ...sharedProviderFieldsShape,
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

/**
 * Shared provider op union used by both codex and claude schemas.
 * Each provider re-exports with its own type alias.
 */
export const providerOpSchema = z.discriminatedUnion('op', [
  sharedExecSchema,
  sharedListSchema,
  sharedForkSchema,
]);
