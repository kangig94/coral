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

const sessionOptions = {
  model: modelSchema,
  working_directory: cwdSchema,
  effort: effortSchema,
  bypass: boolDefaultFalse,
};

const sessionExecFields = {
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  ...sessionOptions,
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
  ...sessionOptions,
});

export const codexOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  forkShape,
]);

export type CodexOpInput = z.infer<typeof codexOpSchema>;
export type CodexSessionCreateInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type CodexSessionSendInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'name'> & { session: string };
export type CodexSessionForkInput = Omit<Extract<CodexOpInput, { op: 'fork' }>, 'op'>;

export const coralAgentSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  effort: effortSchema,
});

export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
