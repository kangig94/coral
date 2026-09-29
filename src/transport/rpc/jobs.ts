import { z } from 'zod';

import { parseBooleanQuery } from '../../infra/json.js';
import { providerIdentPattern } from '../../infra/identifiers.js';
import { jobPhaseSchema } from '../../jobs/phase.js';
import { isWaitCursor, isWaitCursorV2, type WaitCursor } from '../../jobs/wait.js';
import { MAX_WAIT_JOB_IDS } from '../../jobs/wait-stream-event.js';

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
    jobIds: z
      .array(z.string().min(1))
      .min(1, 'At least one job required')
      .max(MAX_WAIT_JOB_IDS, `At most ${MAX_WAIT_JOB_IDS} jobs may be waited on at once`),
    projectRoot: projectRootSchema,
    timeoutSeconds: z.number().int().min(1).max(1200).optional(),
    cursor: waitCursorSchema.optional(),
    // Absent on any CLI built before the `interrupted` event existed — that build's renderer has no case
    // for it and no `default`, so the coordinator must not emit one unless the subscriber names itself able
    // to render it. Never inferred from version or bundle identity: a client that predates the field and one
    // that sends `false` are indistinguishable to the coordinator, and both get the pre-`interrupted` stream.
    supportsInterrupted: z.boolean().optional(),
    supportsWaitV2: z.boolean().optional(),
    // A subscriber that omits this reads a clean end as final, so it must never be sent a handover notice.
    supportsHandover: z.boolean().optional(),
  })
  .strict();

/** A coordinator advertises the `jobs.wait` fields its strict schema accepts on `ping`. */
export const JOBS_WAIT_EXTENSIONS = ['supportsInterrupted', 'supportsWaitV2', 'supportsHandover'] as const;

export type JobsWaitFields = Readonly<{
  jobIds: readonly string[];
  projectRoot: string;
  timeoutSeconds?: number;
  cursor?: WaitCursor;
}>;

/** A vector cursor must be omitted for a coordinator without `supportsWaitV2`; it cannot parse one. */
export function jobsWaitRequest(fields: JobsWaitFields, extensions: readonly string[]): Record<string, unknown> {
  const waitV2 = extensions.includes('supportsWaitV2');
  const cursor =
    fields.cursor === undefined || (!waitV2 && isWaitCursorV2(fields.cursor))
      ? undefined
      : isWaitCursorV2(fields.cursor)
        ? fields.cursor
        : { afterSeq: fields.cursor.afterSeq };
  return {
    jobIds: [...fields.jobIds],
    projectRoot: fields.projectRoot,
    ...(fields.timeoutSeconds === undefined ? {} : { timeoutSeconds: fields.timeoutSeconds }),
    ...(cursor === undefined ? {} : { cursor }),
    // This CLI can render `interrupted`; advertise it only to a coordinator that accepts the field.
    ...Object.fromEntries(JOBS_WAIT_EXTENSIONS.filter((flag) => extensions.includes(flag)).map((flag) => [flag, true])),
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
