import { z } from 'zod';

import { parseBooleanQuery } from '../../infra/json.js';
import { providerIdentPattern } from '../../infra/identifiers.js';
import { jobPhaseSchema } from '../../jobs/phase.js';
import { type WaitCursor } from '../../jobs/wait/contract.js';
import { MAX_WAIT_JOB_IDS } from '../../jobs/wait/stream-event.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const jobIdSchema = z.string().min(1, 'Job ID is required');
const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

const jobWaitFieldsSchema = z.object({
  jobIds: z
    .array(z.string().min(1))
    .min(1, 'At least one job required')
    .max(MAX_WAIT_JOB_IDS, `At most ${MAX_WAIT_JOB_IDS} jobs may be waited on at once`),
  projectRoot: projectRootSchema,
  timeoutSeconds: z.number().int().min(1).max(1200).optional(),
  // Decoded by the wait owner, so an undecodable cursor is a soft typed refusal rather than invalid params.
  cursor: z.unknown(),
  drainProgress: z.boolean().optional(),
});

const uniqueJobIds = (value: { jobIds: readonly string[] }, ctx: z.RefinementCtx): void => {
  if (new Set(value.jobIds).size !== value.jobIds.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['jobIds'],
      message: 'Each job ID must appear only once; remove duplicate job IDs.',
    });
};

/** Unknown fields pass validation so that a request from another build is answered with the restart refusal. */
export const jobWaitSchema = jobWaitFieldsSchema.passthrough().superRefine(uniqueJobIds);

export const jobWaitSnapshotSchema = jobWaitFieldsSchema
  .omit({ timeoutSeconds: true, drainProgress: true })
  .extend({ cursor: z.unknown().optional(), lines: z.number().int().min(1).max(500).optional() })
  .strict()
  .superRefine((value, ctx) => {
    uniqueJobIds(value, ctx);
    if (value.lines !== undefined && value.cursor !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--lines cannot be used with --cursor' });
  });

const WAIT_REQUEST_FIELDS = new Set(['jobIds', 'projectRoot', 'timeoutSeconds', 'cursor', 'drainProgress']);

export const WAIT_BUILD_MISMATCH_REASON =
  'This Coral CLI and the running coordinator are different builds, and wait does not bridge builds.';
export const WAIT_BUILD_MISMATCH_REMEDY =
  'Restart the session so the current Coral plugin loads; the coordinator follows the installed build.';
export const WAIT_BUILD_MISMATCH = {
  code: 'wait_build_mismatch',
  message: `${WAIT_BUILD_MISMATCH_REASON} ${WAIT_BUILD_MISMATCH_REMEDY}`,
} as const;

/**
 * A current CLI always states its frontier, as a cursor string or null for a fresh collection, and sends no other
 * field. A request without a frontier, with a frontier of another type, or with a field this build does not define
 * was formed by another build.
 */
export function waitRequestFromAnotherBuild(request: Readonly<Record<string, unknown>>): boolean {
  return (
    Object.keys(request).some((key) => !WAIT_REQUEST_FIELDS.has(key)) ||
    (request.cursor !== null && typeof request.cursor !== 'string')
  );
}

export type JobsWaitFields = Readonly<{
  jobIds: readonly string[];
  projectRoot: string;
  timeoutSeconds?: number;
  drainProgress?: boolean;
  cursor?: WaitCursor;
}>;

export function jobsWaitRequest(fields: JobsWaitFields): Record<string, unknown> {
  return {
    jobIds: [...fields.jobIds],
    projectRoot: fields.projectRoot,
    ...(fields.timeoutSeconds === undefined ? {} : { timeoutSeconds: fields.timeoutSeconds }),
    ...(fields.drainProgress === true ? { drainProgress: true } : {}),
    cursor: fields.cursor ?? null,
  };
}

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
    projectRoot: projectRootSchema,
  })
  .strict();
