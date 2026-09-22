import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from './node-process.js';

export const persistedNonEmptyStringSchema = z.string().min(1);

export const persistedProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;
