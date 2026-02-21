/**
 * Zod schemas for MCP tool input validation.
 *
 * Each schema validates and types the arguments for one Coral MCP tool.
 */

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
const reasoningEffortSchema = z
  .enum(['low', 'medium', 'high', 'xhigh'])
  .optional();
const backgroundSchema = z.boolean().default(false);
const bypassSandboxSchema = z.boolean().default(false);

export const codexSessionCreateSchema = z.object({
  name: sessionNameSchema.optional(),
  prompt: promptSchema,
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  background: backgroundSchema,
  dangerously_bypass_sandbox: bypassSandboxSchema,
});

export const codexSessionSendSchema = z.object({
  session: sessionRefSchema,
  prompt: promptSchema,
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  background: backgroundSchema,
  dangerously_bypass_sandbox: bypassSandboxSchema,
});

export const codexSessionListSchema = z.object({}).strict();

export const codexSessionForkSchema = z.object({
  session: sessionRefSchema,
  name: sessionNameSchema.optional(),
  prompt: z.string().optional(),
  model: modelSchema,
  working_directory: cwdSchema,
  reasoning_effort: reasoningEffortSchema,
  background: backgroundSchema,
  dangerously_bypass_sandbox: bypassSandboxSchema,
});

export const codexSessionAbortSchema = z.object({
  session: sessionRefSchema,
});

export type CodexSessionCreateInput = z.infer<typeof codexSessionCreateSchema>;
export type CodexSessionSendInput = z.infer<typeof codexSessionSendSchema>;
export type CodexSessionListInput = z.infer<typeof codexSessionListSchema>;
export type CodexSessionForkInput = z.infer<typeof codexSessionForkSchema>;
export type CodexSessionAbortInput = z.infer<typeof codexSessionAbortSchema>;
