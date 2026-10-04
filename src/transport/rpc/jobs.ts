import { decodeWaitCursor } from '../../jobs/wait/cursor.js';
import type { RpcPorts } from './ports.js';
import { z } from 'zod';

import { parseBooleanQuery } from '../../infra/json.js';
import { providerIdentPattern } from '../../infra/identifiers.js';
import { jobPhaseSchema } from '../../jobs/phase.js';
import { type WaitCursor } from '../../jobs/wait/contract.js';
import { MAX_WAIT_JOB_IDS } from '../../jobs/wait/stream-event.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const jobIdSchema = z.string().min(1, 'Job ID is required');
const waitCursorSchema = z.custom<WaitCursor>((value) => decodeWaitCursor(value).kind === 'decoded', {
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
      .max(MAX_WAIT_JOB_IDS, `At most ${MAX_WAIT_JOB_IDS} jobs may be waited on at once`)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Each job ID must appear only once; remove duplicate job IDs.',
      ),
    projectRoot: projectRootSchema,
    timeoutSeconds: z.number().int().min(1).max(1200).optional(),
    cursor: waitCursorSchema.optional(),
    // Absent on any CLI built before the `interrupted` event existed — that build's renderer has no case
    // for it and no `default`, so the coordinator must not emit one unless the subscriber names itself able
    // to render it. Never inferred from version or bundle identity: a client that predates the field and one
    // that sends `false` are indistinguishable to the coordinator, and both get the pre-`interrupted` stream.
    supportsInterrupted: z.boolean().optional(),
    supportsWaitV2: z.boolean().optional(),
    supportsWaitV3: z.boolean().optional(),
    // A subscriber that omits this reads a clean end as final, so it must never be sent a handover notice.
    supportsHandover: z.boolean().optional(),
  })
  .strict();

export const jobWaitSnapshotSchema = jobWaitSchema
  .omit({
    timeoutSeconds: true,
    supportsInterrupted: true,
    supportsHandover: true,
    supportsWaitV2: true,
    supportsWaitV3: true,
  })
  .extend({ lines: z.number().int().min(1).max(500).optional() })
  .superRefine((value, ctx) => {
    if (value.lines !== undefined && value.cursor !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--lines cannot be used with --cursor' });
  });

export const JOBS_WAIT_EXTENSIONS = [
  'supportsInterrupted',
  'supportsWaitV2',
  'supportsHandover',
  'supportsWaitV3',
] as const;

export function jobsWaitExtensions(jobs: Pick<RpcPorts['jobs'], 'snapshot' | 'admitWait'>): readonly string[] {
  return JOBS_WAIT_EXTENSIONS.filter((flag) => flag !== 'supportsWaitV3' || (jobs.snapshot && jobs.admitWait));
}

export type JobsWaitFields = Readonly<{
  jobIds: readonly string[];
  projectRoot: string;
  timeoutSeconds?: number;
  cursor?: WaitCursor;
}>;

/** A saved cursor accepted by the coordinator must be sent unchanged. */
export function jobsWaitRequest(
  fields: JobsWaitFields,
  extensions: readonly string[],
  onCursorReset?: () => void,
): Record<string, unknown> {
  const decoded = fields.cursor === undefined ? undefined : decodeWaitCursor(fields.cursor);
  const generation = decoded?.kind === 'decoded' ? decoded.cursor.version : undefined;
  const accepted =
    decoded === undefined ||
    (decoded.kind === 'decoded' &&
      (generation === undefined ||
        (generation === 'jobs.wait.v2' &&
          (extensions.includes('supportsWaitV2') || extensions.includes('supportsWaitV3'))) ||
        (generation === 'jobs.wait.v3' && extensions.includes('supportsWaitV3'))));
  if (!accepted) onCursorReset?.();
  const cursor = accepted ? fields.cursor : undefined;
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
