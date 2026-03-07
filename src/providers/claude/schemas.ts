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

export const claudeOpSchema = z.discriminatedUnion('op', [
  sharedExecSchema,
  sharedListSchema,
  sharedForkSchema,
]);

export type ClaudeOpInput = z.infer<typeof claudeOpSchema>;
type ClaudeExecInput = Extract<ClaudeOpInput, { op: 'exec' }>;
export type ClaudeSessionCreateInput = Omit<ClaudeExecInput, 'op' | 'session'>;
export type ClaudeSessionSendInput = Omit<ClaudeExecInput, 'op'> & { session: string };
export type ClaudeSessionForkInput = Omit<Extract<ClaudeOpInput, { op: 'fork' }>, 'op'>;

export const coralClaudeSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  work_dir: cwdSchema,
});

export type ClaudeCoralInput = z.infer<typeof coralClaudeSchema>;
