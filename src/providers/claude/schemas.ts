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

const systemPromptSchema = z.string().optional();

const sessionExecFields = {
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  effort: effortSchema,
  system_prompt: systemPromptSchema,
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
  system_prompt: systemPromptSchema,
  bypass: boolDefaultFalse,
});

export const claudeOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  forkShape,
]);

export type ClaudeOpInput = z.infer<typeof claudeOpSchema>;
type ClaudeExecInput = Extract<ClaudeOpInput, { op: 'exec' }>;
export type ClaudeSessionCreateInput = Omit<ClaudeExecInput, 'op' | 'session'>;
export type ClaudeSessionSendInput = Omit<ClaudeExecInput, 'op' | 'name'> & { session: string };
export type ClaudeSessionForkInput = Omit<Extract<ClaudeOpInput, { op: 'fork' }>, 'op'>;

export const coralClaudeSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  effort: effortSchema,
});

export type ClaudeCoralInput = z.infer<typeof coralClaudeSchema>;
