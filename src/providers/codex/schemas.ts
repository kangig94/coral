/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import {
  promptSchema,
  sessionRefSchema,
  cwdSchema,
  coralOpSchema,
} from '../../shared/schemas.js';

const sessionExecFields = {
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  working_directory: cwdSchema,
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
  prompt: z.string().optional(),
  working_directory: cwdSchema,
});

export const codexOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  forkShape,
]);

export type CodexOpInput = z.infer<typeof codexOpSchema>;
export type CodexSessionCreateInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type CodexSessionSendInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op'> & { session: string };
export type CodexSessionForkInput = Omit<Extract<CodexOpInput, { op: 'fork' }>, 'op'>;

export const coralAgentSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  working_directory: cwdSchema,
});

export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
