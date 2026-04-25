import { z } from 'zod';

import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import { jobLaunchRequestBodySchema, type JobLaunchRequestBody } from './launch.js';
import {
  abortReasonSchema,
  externalErrorSchema,
  jobLaunchRejectedSchema,
  jobDomainProgressSchema,
  type JobLaunchRejected,
} from './outcome.js';
import {
  jobTerminalDiagnosticsSchema,
  jobTerminalSchema,
} from './result.js';
import { jobContinuitySnapshotSchema } from './continuity.js';
import {
  reduceJobAborted,
  reduceJobLaunchRejected,
  reduceJobLaunchRequested,
  reduceJobProgress,
  reduceJobQueueAdmitted,
  reduceJobQueueQueued,
  reduceJobRuntimeStarted,
  reduceJobTerminal,
  validateJobTerminalOrder,
} from './projections.js';

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
    operation: z.enum(['kb.source_import', 'kb.reindex']).optional(),
    pid: z.number().optional(),
    stdoutPath: z.string().optional(),
    stderrPath: z.string().optional(),
    startedAt: z.string(),
    providerMeta: z.record(z.unknown()).optional(),
    tailWatermark: z.number().optional(),
  })
  .strict();

export const jobProgressBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), message: z.string(), ts: z.string().optional() }).strict(),
  jobDomainProgressSchema,
  z.object({ kind: z.literal('missing_launch_record') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema }).strict(),
]);

export const jobTerminalRecordedBodySchema = z
  .object({
    terminal: jobTerminalSchema,
    diagnostics: jobTerminalDiagnosticsSchema.optional(),
    continuity: jobContinuitySnapshotSchema.nullable().optional(),
  })
  .strict();

export const jobAbortedBodySchema = z
  .object({
    reason: abortReasonSchema,
  })
  .strict();

export type JobQueueQueuedBody = z.infer<typeof jobQueueQueuedBodySchema>;
export type JobQueueAdmittedBody = z.infer<typeof jobQueueAdmittedBodySchema>;
export type JobRuntimeStartedBody = z.infer<typeof jobRuntimeStartedBodySchema>;
export type JobProgressBody = z.infer<typeof jobProgressBodySchema>;
export type JobTerminaledBody = z.infer<typeof jobTerminalRecordedBodySchema>;
export type JobAbortedBody = z.infer<typeof jobAbortedBodySchema>;

export type JobEventBody =
  | JobLaunchRequestBody
  | JobLaunchRejected
  | JobQueueQueuedBody
  | JobQueueAdmittedBody
  | JobRuntimeStartedBody
  | JobProgressBody
  | JobTerminaledBody
  | JobAbortedBody;

export const jobsRegistry: DomainEventRegistry = {
  entries: [
    defineDomainEvent({ type: 'job.launch.requested', schema: jobLaunchRequestBodySchema, reducer: reduceJobLaunchRequested }),
    defineDomainEvent({ type: 'job.launch.rejected', schema: jobLaunchRejectedSchema, reducer: reduceJobLaunchRejected }),
    defineDomainEvent({ type: 'job.queue.queued', schema: jobQueueQueuedBodySchema, reducer: reduceJobQueueQueued }),
    defineDomainEvent({ type: 'job.queue.admitted', schema: jobQueueAdmittedBodySchema, reducer: reduceJobQueueAdmitted }),
    defineDomainEvent({ type: 'job.runtime.started', schema: jobRuntimeStartedBodySchema, reducer: reduceJobRuntimeStarted }),
    defineDomainEvent({ type: 'job.progress.emitted', schema: jobProgressBodySchema, reducer: reduceJobProgress }),
    defineDomainEvent({ type: 'job.terminal.recorded', schema: jobTerminalRecordedBodySchema, reducer: reduceJobTerminal }),
    defineDomainEvent({ type: 'job.aborted', schema: jobAbortedBodySchema, reducer: reduceJobAborted }),
  ],
  appendValidators: [validateJobTerminalOrder],
};
