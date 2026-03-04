import { z } from 'zod';
import { identPattern, providerIdentPattern } from './mcp-utils.js';

export const modelSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores')
  .optional();

export const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(identPattern, 'Session name must be alphanumeric (with . _ - allowed)');

export const promptSchema = z.string().min(1, 'Prompt is required');

export const sessionRefSchema = z.string().min(1, 'Session reference is required');

export const cwdSchema = z.string().optional();

export const boolDefaultFalse = z.boolean().default(false);

export const coralOpSchema = z
  .string()
  .regex(
    /^coral:[a-z0-9][a-z0-9-]*$/,
    'Op must be coral:<agent-name> (lowercase letters, digits, hyphens)',
  );

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');
