/**
 * Zod schemas for MCP tool input validation.
 *
 * Each schema validates and types the arguments for one Coral MCP tool.
 */

import { z } from 'zod';

const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
const reasoningEffortSchema = z
  .enum(['low', 'medium', 'high', 'xhigh'])
  .optional();

export const codexSessionCreateSchema = z.object({
  name: sessionNameSchema.optional(),
  prompt: promptSchema,
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
});

export const codexSessionSendSchema = z.object({
  session: sessionRefSchema,
  prompt: promptSchema,
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
});

export const codexSessionListSchema = z.object({}).passthrough();

export const codexSessionForkSchema = z.object({
  session: sessionRefSchema,
  name: sessionNameSchema.optional(),
  prompt: z.string().optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
});

export type CodexSessionCreateInput = z.infer<typeof codexSessionCreateSchema>;
export type CodexSessionSendInput = z.infer<typeof codexSessionSendSchema>;
export type CodexSessionListInput = z.infer<typeof codexSessionListSchema>;
export type CodexSessionForkInput = z.infer<typeof codexSessionForkSchema>;
