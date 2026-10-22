import { z } from 'zod';

import { executionOrdinalSchema } from './launch.js';
import { providerArtifactIdentityKey, providerArtifactIdentitySchema } from '../providers/artifact-identity.js';
import { continuitySnapshotSchema } from './conversation/continuity.js';
import {
  sessionInterruptedFaultSchema,
  sessionProviderFailedFaultSchema,
  sessionAdapterUnparseableFaultSchema,
} from './conversation/fault.js';
import { executionCauseRefSchema, externalErrorSchema, jobDomainProgressSchema } from './outcome.js';

export const jobQueueQueuedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    queuePosition: z.number().int().nonnegative(),
    runningJobIds: z.array(z.string()),
  })
  .strict();

export const jobQueueAdmittedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

const runtimeStartedAtSchema = z.string().min(1);

const providerHostRefIdentitySchema = {
  provider: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  instanceId: z.string().min(1),
} as const;

export const providerHostRefSchema = z.discriminatedUnion('leaseMode', [
  z
    .object({
      ...providerHostRefIdentitySchema,
      leaseMode: z.literal('shared'),
    })
    .strict(),
  z
    .object({
      ...providerHostRefIdentitySchema,
      leaseMode: z.literal('job-exclusive'),
      ownerJobId: z.string().min(1),
    })
    .strict(),
]);

const durableCliRuntimeStartedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    transport: z.literal('durable-cli'),
    pid: z.number().int().positive(),
    stdoutPath: z.string().min(1),
    stderrPath: z.string().min(1),
    startedAt: runtimeStartedAtSchema,
    tailWatermark: z.number().int().nonnegative().optional(),
  })
  .strict();

const appServerRuntimeStartedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    transport: z.literal('app-server'),
    startedAt: runtimeStartedAtSchema,
    providerMeta: z.discriminatedUnion('leaseState', [
      z
        .object({
          provider: z.string().min(1),
          leaseState: z.literal('waiting'),
        })
        .strict(),
      z
        .object({
          provider: z.string().min(1),
          leaseState: z.literal('acquired'),
          hostRef: providerHostRefSchema,
        })
        .strict(),
    ]),
  })
  .strict();

const internalRuntimeStartedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    transport: z.literal('internal'),
    operation: z.enum(['kb.source_import', 'kb.reindex', 'kb.community_summary']),
    owner: z.enum(['parent', 'kb-daemon']).optional(),
    startedAt: runtimeStartedAtSchema,
  })
  .strict();

const workflowRuntimeStartedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    transport: z.literal('workflow'),
    startedAt: runtimeStartedAtSchema,
  })
  .strict();

export const jobRuntimeStartedBodySchema = z
  .discriminatedUnion('transport', [
    durableCliRuntimeStartedBodySchema,
    appServerRuntimeStartedBodySchema,
    internalRuntimeStartedBodySchema,
    workflowRuntimeStartedBodySchema,
  ])
  .describe('validate-current-job-runtime-variant-consistency');

export const jobProgressTimingSchema = z
  .object({
    origin: z.enum(['runtime', 'queued', 'launch']),
    originAt: z.string(),
    emittedAt: z.string(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export const jobProgressBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      execution: executionOrdinalSchema,
      kind: z.literal('message'),
      message: z.string(),
      timing: jobProgressTimingSchema,
    })
    .strict(),
  jobDomainProgressSchema.extend({ execution: executionOrdinalSchema }),
  z.object({ execution: executionOrdinalSchema, kind: z.literal('missing_launch_record') }).strict(),
  z
    .object({ execution: executionOrdinalSchema, kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema })
    .strict(),
]);

export type JobQueueQueuedBody = z.infer<typeof jobQueueQueuedBodySchema>;
export type JobQueueAdmittedBody = z.infer<typeof jobQueueAdmittedBodySchema>;
export type JobRuntimeStartedBody = z.infer<typeof jobRuntimeStartedBodySchema>;
export type JobProgressTiming = z.infer<typeof jobProgressTimingSchema>;
export type JobProgressBody = z.infer<typeof jobProgressBodySchema>;

export const jobContinuityCheckpointedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    snapshot: continuitySnapshotSchema,
  })
  .strict();

export const jobArtifactRecordedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    provider: z.string().min(1),
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema,
    identityKey: z.string().min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.identityKey !== providerArtifactIdentityKey(body.provider, body.identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityKey'],
        message: 'Artifact identityKey must match its provider and identity.',
      });
    }
  });

const retentionDiscardFields = {
  execution: executionOrdinalSchema,
  attempt: z.number().int().nonnegative().safe(),
  handles: z.array(z.string().min(1)).readonly(),
};

export const jobRetentionDiscardRequestedBodySchema = z.object(retentionDiscardFields).strict();
export const jobRetentionDiscardCompletedBodySchema = z
  .object({
    ...retentionDiscardFields,
    outcome: z.enum(['discarded', 'skipped_no_handles', 'provider_declares_none']),
  })
  .strict();
export const jobRetentionDiscardFailedBodySchema = z
  .object({
    ...retentionDiscardFields,
    reason: z.string().min(1),
    causeRef: executionCauseRefSchema.optional(),
  })
  .strict();

export const jobInterruptedBodySchema = sessionInterruptedFaultSchema.extend({ execution: executionOrdinalSchema });
export const jobProviderFailedBodySchema = sessionProviderFailedFaultSchema.extend({
  execution: executionOrdinalSchema,
});
export const jobAdapterUnparseableBodySchema = sessionAdapterUnparseableFaultSchema.extend({
  execution: executionOrdinalSchema,
});

export type JobContinuityCheckpointedBody = z.infer<typeof jobContinuityCheckpointedBodySchema>;
export type JobArtifactRecordedBody = z.infer<typeof jobArtifactRecordedBodySchema>;
export type JobRetentionDiscardRequestedBody = z.infer<typeof jobRetentionDiscardRequestedBodySchema>;
export type JobRetentionDiscardCompletedBody = z.infer<typeof jobRetentionDiscardCompletedBodySchema>;
export type JobRetentionDiscardFailedBody = z.infer<typeof jobRetentionDiscardFailedBodySchema>;
export type JobInterruptedBody = z.infer<typeof jobInterruptedBodySchema>;
export type JobProviderFailedBody = z.infer<typeof jobProviderFailedBodySchema>;
export type JobAdapterUnparseableBody = z.infer<typeof jobAdapterUnparseableBodySchema>;
