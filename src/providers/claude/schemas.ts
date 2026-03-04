import { z } from 'zod';
import {
  modelSchema,
  sessionNameSchema,
  promptSchema,
  sessionRefSchema,
  cwdSchema,
  boolDefaultFalse,
  coralOpSchema,
} from '../../shared/schemas.js';

const systemPromptSchema = z.string().optional();

const execShape = z.object({
  op: z.literal('exec'),
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  system_prompt: systemPromptSchema,
  bypass: boolDefaultFalse,
});

const listShape = z.object({
  op: z.literal('list'),
}).strict();

const abortShape = z.object({
  op: z.literal('abort'),
  session: z.string().uuid('Session must be a valid UUID'),
});

export const claudeOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  abortShape,
]);

export type ClaudeOpInput = z.infer<typeof claudeOpSchema>;
export type ClaudeSessionCreateInput = Omit<Extract<ClaudeOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type ClaudeSessionSendInput = Omit<Extract<ClaudeOpInput, { op: 'exec' }>, 'op' | 'name'> & { session: string };
export type ClaudeSessionAbortInput = Omit<z.infer<typeof abortShape>, 'op'>;

export const coralClaudeSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  system_prompt: systemPromptSchema,
  bypass: boolDefaultFalse,
});

export type ClaudeCoralInput = z.infer<typeof coralClaudeSchema>;
