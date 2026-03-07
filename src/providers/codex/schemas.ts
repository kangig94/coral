/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import {
  sharedExecSchema,
  sharedListSchema,
  sharedForkSchema,
  coralOpSchema,
  promptSchema,
  sessionRefSchema,
  cwdSchema,
} from '../../shared/schemas.js';

export const codexOpSchema = z.discriminatedUnion('op', [
  sharedExecSchema,
  sharedListSchema,
  sharedForkSchema,
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
