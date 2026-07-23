// Job event body schemas + types for events whose bodies have no natural
// domain-companion home (queue/runtime/progress lifecycle phases — distinct
// from launch/outcome/result which carry substantive helpers in their own
// files). Exists as a cycle-break sibling: keeping these inline in events.ts
// would force projections.ts to either type-only-import them (creating the
// runtime↔type cycle) or redeclare structural duplicates. A cycle-break split
// like this mirrors `kb/corpus/manifest-types.ts`.

import { z } from 'zod';

import { externalErrorSchema, jobDomainProgressSchema } from './outcome.js';

export const jobQueueQueuedBodySchema = z
  .object({
    queuePosition: z.number().int().nonnegative(),
    runningJobIds: z.array(z.string()),
  })
  .strict();

export const jobQueueAdmittedBodySchema = z
  .object({
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
    transport: z.literal('internal'),
    operation: z.enum(['kb.source_import', 'kb.reindex', 'kb.community_summary']),
    owner: z.enum(['parent', 'kb-daemon']).optional(),
    startedAt: runtimeStartedAtSchema,
  })
  .strict();

const workflowRuntimeStartedBodySchema = z
  .object({
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
  z.object({ kind: z.literal('message'), message: z.string(), timing: jobProgressTimingSchema }).strict(),
  jobDomainProgressSchema,
  z.object({ kind: z.literal('missing_launch_record') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema }).strict(),
]);

export type JobQueueQueuedBody = z.infer<typeof jobQueueQueuedBodySchema>;
export type JobQueueAdmittedBody = z.infer<typeof jobQueueAdmittedBodySchema>;
export type JobRuntimeStartedBody = z.infer<typeof jobRuntimeStartedBodySchema>;
export type JobProgressTiming = z.infer<typeof jobProgressTimingSchema>;
export type JobProgressBody = z.infer<typeof jobProgressBodySchema>;
