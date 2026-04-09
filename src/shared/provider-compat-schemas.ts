import { z } from 'zod';
import { identPattern } from './utils.js';
import { cwdSchema, modelSchema, promptSchema, sessionRefSchema } from './schemas.js';

const coralOpSchema = z
  .string()
  .regex(/^coral:[a-z0-9][a-z0-9-]*$/, 'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)');

const sharedProviderFieldsShape = {
  work_dir: cwdSchema,
  model: modelSchema,
};

/**
 * Internal-only fields accepted by the backend but not exposed in the provider input schema.
 * bypass_permissions: set by CLI/internal callers, or implied by fork/resume/coral:* flows.
 * system_prompt: injected by coral:* dispatch or internal callers — not user-facing.
 */
export const internalProviderFieldsShape = {
  bypass_permissions: z.boolean().optional(),
  system_prompt: z.string().optional(),
};

/**
 * Shared exec input schema (provider-neutral).
 * Providers extend this with extras (e.g. system_prompt for Claude).
 */
export const sharedExecSchema = z.object({
  op: z.literal('exec'),
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
export const sharedListSchema = z
  .object({
    op: z.literal('list'),
  })
  .strict();

/**
 * Shared provider op union used by both codex and claude schemas.
 * Each provider re-exports with its own type alias.
 */
export const providerOpSchema = z.discriminatedUnion('op', [sharedExecSchema, sharedListSchema, sharedForkSchema]);

/** Shared coral agent schema used by both codex and claude tools. */
export const coralAgentOpSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  work_dir: cwdSchema,
  owner: z.string().regex(identPattern, 'Owner must be token-safe').optional(),
});

export type CoralAgentOpInput = z.infer<typeof coralAgentOpSchema>;
