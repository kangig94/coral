/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import { providerOpSchema, coralOpSchema, promptSchema, sessionRefSchema, cwdSchema } from '../../shared/schemas.js';
import { identPattern } from '../../shared/mcp-utils.js';

export const codexOpSchema = providerOpSchema;

export type CodexOpInput = z.infer<typeof codexOpSchema>;
export type CodexSessionCreateInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type CodexSessionSendInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op'> & { session: string };
export type CodexSessionForkInput = Omit<Extract<CodexOpInput, { op: 'fork' }>, 'op'>;

export const coralAgentSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  work_dir: cwdSchema,
  owner: z.string().regex(identPattern, 'Owner must be token-safe').optional(),
});

export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
