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
    runningJobIds: z.array(z.string()).default([]),
  })
  .strict();

export const jobQueueAdmittedBodySchema = z
  .object({
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

export const jobRuntimeStartedBodySchema = z
  .object({
    transport: z.enum(['durable-cli', 'app-server', 'internal']).optional(),
    operation: z.enum(['kb.source_import', 'kb.reindex', 'kb.community_summary']).optional(),
    owner: z.enum(['parent', 'kb-daemon']).optional(),
    pid: z.number().finite().optional(),
    stdoutPath: z.string().optional(),
    stderrPath: z.string().optional(),
    startedAt: z.string(),
    providerMeta: z.record(z.unknown()).optional(),
    tailWatermark: z.number().finite().optional(),
  })
  .strict();

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
