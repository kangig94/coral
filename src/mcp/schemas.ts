/**
 * Zod schemas for MCP tool input validation.
 *
 * Each schema validates and types the arguments for one Coral MCP tool.
 */

import { z } from 'zod';

const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const modelSchema = z
  .string()
  .regex(modelPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores')
  .optional();

export const codexExecuteSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  model: modelSchema,
  working_directory: z.string().optional(),
  save_session: z.string().optional(),
});

export const codexSessionCreateSchema = z.object({
  name: z
    .string()
    .min(1, 'Session name is required')
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Session name must be alphanumeric (with . _ - allowed)'),
  prompt: z.string().min(1, 'Prompt is required'),
  model: modelSchema,
  working_directory: z.string().optional(),
});

export const codexSessionSendSchema = z.object({
  session: z.string().min(1, 'Session reference is required'),
  prompt: z.string().min(1, 'Prompt is required'),
  model: modelSchema,
  working_directory: z.string().optional(),
});

export const codexSessionListSchema = z.object({}).passthrough();

export const codexSessionForkSchema = z.object({
  session: z.string().min(1, 'Session reference is required'),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Session name must be alphanumeric (with . _ - allowed)')
    .optional(),
  prompt: z.string().optional(),
  model: modelSchema,
  working_directory: z.string().optional(),
});

export type CodexExecuteInput = z.infer<typeof codexExecuteSchema>;
export type CodexSessionCreateInput = z.infer<typeof codexSessionCreateSchema>;
export type CodexSessionSendInput = z.infer<typeof codexSessionSendSchema>;
export type CodexSessionListInput = z.infer<typeof codexSessionListSchema>;
export type CodexSessionForkInput = z.infer<typeof codexSessionForkSchema>;
