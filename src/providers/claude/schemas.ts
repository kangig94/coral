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

export const claudeOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  forkShape,
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
  working_directory: cwdSchema,
});

export type ClaudeCoralInput = z.infer<typeof coralClaudeSchema>;
