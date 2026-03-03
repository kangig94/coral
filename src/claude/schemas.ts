import { z } from 'zod';
import { identPattern } from '../shared/mcp-utils.js';

const modelSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores')
  .optional();

const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(identPattern, 'Session name must be alphanumeric (with . _ - allowed)');

const promptSchema = z.string().min(1, 'Prompt is required');
const sessionRefSchema = z.string().min(1, 'Session reference is required');
const cwdSchema = z.string().optional();
const systemPromptSchema = z.string().optional();

const execShape = z.object({
  op: z.literal('exec'),
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  system_prompt: systemPromptSchema,
});

const listShape = z.object({
  op: z.literal('list'),
}).strict();

const waitShape = z.object({
  op: z.literal('wait'),
  sessions: z.array(z.string().uuid()).min(1, 'At least one session required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
});

const abortShape = z.object({
  op: z.literal('abort'),
  session: z.string().uuid('Session must be a valid UUID'),
});

export const claudeOpSchema = z.discriminatedUnion('op', [
  execShape,
  listShape,
  waitShape,
  abortShape,
]);

export type ClaudeOpInput = z.infer<typeof claudeOpSchema>;
export type ClaudeSessionCreateInput = Omit<Extract<ClaudeOpInput, { op: 'exec' }>, 'op' | 'session'>;
export type ClaudeSessionSendInput = Omit<Extract<ClaudeOpInput, { op: 'exec' }>, 'op' | 'name'> & { session: string };
export type ClaudeWaitInput = z.infer<typeof waitShape>;
export type ClaudeSessionAbortInput = Omit<z.infer<typeof abortShape>, 'op'>;

const coralOpSchema = z
  .string()
  .regex(
    /^coral:[a-z0-9][a-z0-9-]*$/,
    'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)',
  );

export const coralClaudeSchema = z.object({
  op: coralOpSchema,
  prompt: promptSchema,
  session: sessionRefSchema.optional(),
  name: sessionNameSchema.optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  system_prompt: systemPromptSchema,
});

export type ClaudeCoralInput = z.infer<typeof coralClaudeSchema>;
