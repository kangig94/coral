import { z } from 'zod';

import { parseBooleanQuery } from '../../infra/json.js';
import { providerIdentPattern } from '../../infra/identifiers.js';
import { jobPhaseSchema } from '../../jobs/phase.js';
import { isWaitCursor, type WaitCursor } from '../../jobs/wait.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const jobIdSchema = z.string().min(1, 'Job ID is required');
const waitCursorSchema = z.custom<WaitCursor>(isWaitCursor, {
  message: 'cursor must be a valid wait cursor',
});
const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

export const jobWaitSchema = z
  .object({
    jobIds: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
    timeoutSeconds: z.number().int().min(1).max(1200).optional(),
    cursor: waitCursorSchema.optional(),
  })
  .strict();

export const jobAbortSchema = z
  .object({
    jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
    projectRoot: projectRootSchema,
  })
  .strict();

export const jobsListRequestSchema = z
  .object({
    projectRoot: projectRootSchema.optional(),
    phase: jobPhaseSchema.optional(),
    all: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    provider: providerNameSchema.optional(),
  })
  .strict();

export const jobDetailRequestSchema = z
  .object({
    jobId: jobIdSchema,
  })
  .strict();
