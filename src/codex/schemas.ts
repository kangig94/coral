/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import { identPattern } from '../shared/mcp-utils.js';

const modelSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores')
  .optional();

const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(identPattern, 'Session name must be alphanumeric (with . _ - allowed)');

const promptSchema = z.string().min(1, 'Prompt is required');
const sessionRefSchema = z.string().min(1, 'Session reference is required');
const cwdSchema = z.string().optional();
const reasoningEffortSchema = z
  .enum(['low', 'medium', 'high', 'xhigh'])
  .optional();
const boolDefaultFalse = z.boolean().default(false);

const execShape = z.object({
  op: z.literal('exec'),
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  bypass: boolDefaultFalse,
});

const listShape = z.object({
  op: z.literal('list'),
}).strict();

const forkShape = z.object({
  op: z.literal('fork'),
  session: sessionRefSchema,
  name: sessionNameSchema.optional(),
  prompt: z.string().optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  bypass: boolDefaultFalse,
});

const abortShape = z.object({
  op: z.literal('abort'),
  session: z.string().uuid('Session must be a valid UUID'),
});

export const codexOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  forkShape,
  abortShape,
]);

export type CodexOpInput = z.infer<typeof codexOpSchema>;
export type CodexSessionCreateInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type CodexSessionSendInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'name'> & { session: string };
export type CodexSessionForkInput = Omit<Extract<CodexOpInput, { op: 'fork' }>, 'op'>;
export type CodexSessionAbortInput = Omit<z.infer<typeof abortShape>, 'op'>;

// Stricter than identPattern: agent names are kebab-case only.
const coralOpSchema = z
  .string()
  .regex(
    /^coral:[a-z0-9][a-z0-9-]*$/,
    'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)',
  );

export const coralAgentSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  bypass: boolDefaultFalse,
});

export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
