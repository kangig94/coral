/**
 * Zod schemas for MCP tool input validation.
 *
 * One unified `codex` tool drives all session operations via an `op` discriminator.
 */

import { z } from 'zod';
import { providerOpSchema, coralAgentOpSchema } from '../../shared/provider-compat-schemas.js';

export const codexOpSchema = providerOpSchema;

export type CodexOpInput = z.infer<typeof codexOpSchema>;
export type CodexSessionCreateInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type CodexSessionSendInput = Omit<Extract<CodexOpInput, { op: 'exec' }>, 'op'> & { session: string };
export type CodexSessionForkInput = Omit<Extract<CodexOpInput, { op: 'fork' }>, 'op'>;

export const coralAgentSchema = coralAgentOpSchema;
export type CoralAgentInput = z.infer<typeof coralAgentSchema>;
