import { z } from 'zod';
import type { EffortLevel } from './types.js';
import { AGENT_IDENT_RE, identPattern, providerIdentPattern } from './identifiers.js';

const modelNameSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores');

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

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

export const agentIdentSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.endsWith('.md') ? value.slice(0, -3) : value),
  z
    .string()
    .regex(
      AGENT_IDENT_RE,
      'Agent must be "<name>" or "<namespace>:<name>" (lowercase letters, digits, hyphens)',
    ),
);

const projectRootSchema = z.string().min(1, 'Project root is required');
const ownerSchema = z.string().regex(identPattern, 'Owner must be token-safe');
const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const claudeModelCapSchema = modelNameSchema.optional();

const continuationFieldsShape = {
  projectRoot: projectRootSchema,
  provider: providerNameSchema.optional(),
  model: modelSchema,
  workDir: cwdSchema,
  owner: ownerSchema.optional(),
  effort: effortLevelSchema.optional(),
  claudeModelCap: claudeModelCapSchema,
  bypassPermissions: z.boolean().optional(),
  systemPrompt: z.string().optional(),
} satisfies z.ZodRawShape;

export const sessionCreateSchema = z
  .object({
    provider: providerNameSchema,
    prompt: promptSchema,
    projectRoot: projectRootSchema,
    model: modelSchema,
    agent: agentIdentSchema.optional(),
    workDir: cwdSchema,
    owner: ownerSchema.optional(),
    effort: effortLevelSchema.optional(),
    claudeModelCap: claudeModelCapSchema,
    bypassPermissions: z.boolean().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const sessionMessageSchema = z
  .object({
    prompt: promptSchema,
    ...continuationFieldsShape,
  })
  .strict();

export const sessionForkSchema = z
  .object({
    prompt: z.string().optional(),
    ...continuationFieldsShape,
  })
  .strict();

export const waitCursorSchema = z
  .object({
    jobs: z.record(z.number().int().min(0)),
  })
  .strict();

export const jobWaitSchema = z
  .object({
    jobIds: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
    timeoutSeconds: z.number().int().min(1).max(1200).optional(),
  })
  .strict();

export const jobAbortSchema = z
  .object({
    jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
  })
  .strict();

export const workflowCommandSchema = z
  .object({
    expression: z.string().min(1, 'Expression required'),
    startPrompt: z.string().min(1, 'Prompt required'),
    context: z.string().optional(),
    provider: providerNameSchema.default('claude'),
    workDir: cwdSchema,
    owner: ownerSchema.optional(),
  })
  .strict();

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;

export const workflowRequestSchema = workflowCommandSchema
  .extend({
    projectRoot: projectRootSchema,
    claudeModelCap: claudeModelCapSchema,
  })
  .strict();

export type { EffortLevel } from './types.js';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
export const ABSTRACT_MODEL_TIERS: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

/**
 * Validate an effort string. Returns undefined when the input is undefined.
 * Throws with a user-friendly label when the string is non-empty but invalid.
 */
export function parseEffortLevel(value: string | undefined, label: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!VALID_EFFORT_LEVELS.has(value)) {
    throw new Error(`Invalid ${label}="${value}". Valid values: low, medium, high, xhigh, max`);
  }
  return value as EffortLevel;
}

/**
 * Validate the effort level supplied directly on a request. Returns undefined
 * when the caller did not specify one — each provider adapter then applies
 * its own env-aware fallback chain at the boundary.
 */
export function resolveEffort(requestEffort: string | undefined): EffortLevel | undefined {
  return parseEffortLevel(requestEffort, 'effort');
}

export function resolveProviderEffort(
  request: { effort?: EffortLevel | undefined },
  providerEnvKey: string,
  env: Record<string, string>,
): EffortLevel | undefined {
  return (
    request.effort
    ?? parseEffortLevel(env[providerEnvKey], providerEnvKey)
    ?? parseEffortLevel(env.CORAL_EFFORT, 'CORAL_EFFORT')
  );
}

/** Resolve abstract model tiers. Returns undefined for abstract tiers (provider decides). */
export function resolveModelTier(model: string | undefined, cap?: string): string | undefined {
  if (model === undefined) return undefined;
  const modelRank = ABSTRACT_MODEL_TIERS[model];
  if (modelRank === undefined) return model;
  if (cap !== undefined) {
    const capRank = ABSTRACT_MODEL_TIERS[cap];
    if (capRank !== undefined && modelRank > capRank) return cap;
  }
  return undefined;
}

/** Maximum serialized emitted CallToolResult body length for optional content embedding. */
export const MAX_INLINE = 10_000;

/**
 * Wait tool input schema — accepts a list of jobIds to monitor.
 */
export const waitInputSchema = z
  .object({
    jobs: z.array(z.string()).min(1, 'At least one job required'),
    timeout_seconds: z.number().min(1).max(1200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type WaitInput = z.infer<typeof waitInputSchema>;

/**
 * Abort tool input schema — accepts a list of jobIds to abort.
 */
export const abortInputSchema = z.object({
  jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
});

export type AbortInput = z.infer<typeof abortInputSchema>;
