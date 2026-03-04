/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import {
  modelSchema,
  sessionNameSchema,
  promptSchema,
  sessionRefSchema,
  cwdSchema,
  boolDefaultFalse,
  effortSchema,
  coralOpSchema,
} from '../../shared/schemas.js';

const sessionExecFields = {
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  effort: effortSchema,
  bypass: boolDefaultFalse,
};

const execShape = z.object({
  op: z.literal('exec'),
  ...sessionExecFields,
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
  effort: effortSchema,
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

export const coralAgentSchema = z.object({
  op: coralOpSchema,
  ...sessionExecFields,
});

export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
