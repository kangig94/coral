import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';

export const absoluteProfilePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path must not contain NUL')
  .describe('reject-nul-in-provider-profile-path')
  .refine((value) => isAbsolute(value), 'Path must be absolute')
  .describe('require-absolute-provider-profile-path')
  .transform((value) => normalize(value))
  .describe('normalize-provider-profile-path');
