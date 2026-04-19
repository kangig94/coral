import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { MAX_BUFFER } from '../shared/process-constants.js';
import type { CoralEvent } from '../store/envelope.js';
import type { DomainEventRegistry, Reducer } from '../store/reducers.js';
import { jobLaunchRequestBodySchema, type JobLaunchRequestBody } from './launch.js';
import { type JobPhase } from './phase.js';
import {
  abortReasonSchema,
  externalErrorSchema,
  jobLaunchRejectedSchema,
  phaseForOutcome,
  terminalOutcomeSchema,
  type JobLaunchRejected,
  type JobProgressFault,
  type TerminalOutcome,
} from './outcome.js';
import { usageSummarySchema } from '../providers/protocol.js';
import { jobDiagnosticsSchema, jobTerminalSchema, type JobDiagnostics, type JobTerminal } from './result.js';
import { workflowResultMetaSchema } from './records.js';

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
    transport: z.enum(['durable-cli', 'app-server']).optional(),
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
  z.object({ kind: z.literal('stale_status_schema') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema }).strict(),
]);

export const jobTerminalRecordedBodySchema = z
  .object({
    outcome: terminalOutcomeSchema,
    durationMs: z.number(),
    content: z.string().max(MAX_BUFFER).optional(),
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    code: z.number().optional(),
    note: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    workflow: workflowResultMetaSchema.optional(),
    nonResumable: z.boolean().optional(),
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
export type JobTerminalRecordedBody = z.infer<typeof jobTerminalRecordedBodySchema>;
export type JobAbortedBody = z.infer<typeof jobAbortedBodySchema>;

export type JobEventBody =
  | JobLaunchRequestBody
  | JobLaunchRejected
  | JobQueueQueuedBody
  | JobQueueAdmittedBody
  | JobRuntimeStartedBody
  | JobProgressBody
  | JobTerminalRecordedBody
  | JobAbortedBody;

type ProjectionJobRow = {
  phase: JobPhase;
  terminal: JobTerminal | null;
  diagnostics: JobDiagnostics;
  parentJobId: string | null;
  workflowSlot: string | null;
};

function emptyDiagnostics(): JobDiagnostics {
  return { progressFaults: [] };
}

function readProjectionJob(db: Database, jobId: string): ProjectionJobRow | null {
  const row = db
    .prepare(
      `SELECT phase, terminal, diagnostics, parent_job_id, workflow_slot
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as
    | {
        phase: string;
        terminal: string | null;
        diagnostics: string | null;
        parent_job_id: string | null;
        workflow_slot: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    phase: row.phase as JobPhase,
    terminal: row.terminal === null ? null : jobTerminalSchema.parse(JSON.parse(row.terminal)),
    diagnostics: row.diagnostics === null ? emptyDiagnostics() : jobDiagnosticsSchema.parse(JSON.parse(row.diagnostics)),
    parentJobId: row.parent_job_id,
    workflowSlot: row.workflow_slot,
  };
}

function upsertProjectionJob(
  db: Database,
  event: CoralEvent,
  patch: Partial<ProjectionJobRow>,
): void {
  const previous =
    readProjectionJob(db, event.stream.id) ?? {
      phase: 'launching' as JobPhase,
      terminal: null,
      diagnostics: emptyDiagnostics(),
      parentJobId: event.refs?.parentJobId ?? null,
      workflowSlot: event.refs?.workflowSlotId ?? null,
    };

  const next: ProjectionJobRow = {
    phase: patch.phase ?? previous.phase,
    terminal: patch.terminal ?? previous.terminal,
    diagnostics: patch.diagnostics ?? previous.diagnostics,
    parentJobId: patch.parentJobId ?? previous.parentJobId,
    workflowSlot: patch.workflowSlot ?? previous.workflowSlot,
  };

  db.prepare(
    `INSERT INTO projection_jobs (job_id, phase, terminal, diagnostics, parent_job_id, workflow_slot, last_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       phase = excluded.phase,
       terminal = excluded.terminal,
       diagnostics = excluded.diagnostics,
       parent_job_id = excluded.parent_job_id,
       workflow_slot = excluded.workflow_slot,
       last_seq = excluded.last_seq`,
  ).run(
    event.stream.id,
    next.phase,
    next.terminal === null ? null : JSON.stringify(next.terminal),
    JSON.stringify(next.diagnostics),
    next.parentJobId,
    next.workflowSlot,
    event.seq,
  );
}

function reducerForRequested(): Reducer<JobLaunchRequestBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, {
      phase: 'launching',
      parentJobId: event.body.parentJobId ?? event.refs?.parentJobId ?? null,
      workflowSlot: event.body.workflowSlot ?? event.refs?.workflowSlotId ?? null,
    });
  };
}

function reducerForRejected(): Reducer<JobLaunchRejected> {
  return (db, event) => {
    upsertProjectionJob(db, event, { phase: 'error' });
  };
}

function reducerForQueued(): Reducer<JobQueueQueuedBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, { phase: 'queued' });
  };
}

function reducerForAdmitted(): Reducer<JobQueueAdmittedBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, { phase: 'launching' });
  };
}

function reducerForStarted(): Reducer<JobRuntimeStartedBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, { phase: 'running' });
  };
}

function reducerForProgress(): Reducer<JobProgressBody> {
  return (db, event) => {
    const previous = readProjectionJob(db, event.stream.id);
    if (event.body.kind === 'message') {
      upsertProjectionJob(db, event, {});
      return;
    }

    const diagnostics: JobDiagnostics = {
      progressFaults: [...(previous?.diagnostics.progressFaults ?? []), event.body as JobProgressFault],
    };

    upsertProjectionJob(db, event, { diagnostics });
  };
}

function reducerForTerminal(): Reducer<JobTerminalRecordedBody> {
  return (db, event) => {
    const terminal: JobTerminal = {
      outcome: event.body.outcome,
      durationMs: event.body.durationMs,
    };
    upsertProjectionJob(db, event, {
      phase: phaseForOutcome(event.body.outcome),
      terminal,
    });
  };
}

function reducerForAborted(): Reducer<JobAbortedBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, { phase: 'aborted' });
  };
}

export const jobsRegistry: DomainEventRegistry = {
  types: [
    'job.launch.requested',
    'job.launch.rejected',
    'job.queue.queued',
    'job.queue.admitted',
    'job.runtime.started',
    'job.progress.emitted',
    'job.terminal.recorded',
    'job.aborted',
  ],
  reducers: {
    'job.launch.requested': reducerForRequested() as Reducer<unknown>,
    'job.launch.rejected': reducerForRejected() as Reducer<unknown>,
    'job.queue.queued': reducerForQueued() as Reducer<unknown>,
    'job.queue.admitted': reducerForAdmitted() as Reducer<unknown>,
    'job.runtime.started': reducerForStarted() as Reducer<unknown>,
    'job.progress.emitted': reducerForProgress() as Reducer<unknown>,
    'job.terminal.recorded': reducerForTerminal() as Reducer<unknown>,
    'job.aborted': reducerForAborted() as Reducer<unknown>,
  },
  schemas: {
    'job.launch.requested': jobLaunchRequestBodySchema,
    'job.launch.rejected': jobLaunchRejectedSchema,
    'job.queue.queued': jobQueueQueuedBodySchema,
    'job.queue.admitted': jobQueueAdmittedBodySchema,
    'job.runtime.started': jobRuntimeStartedBodySchema,
    'job.progress.emitted': jobProgressBodySchema,
    'job.terminal.recorded': jobTerminalRecordedBodySchema,
    'job.aborted': jobAbortedBodySchema,
  },
};

export function projectionPhaseForTerminal(outcome: TerminalOutcome): JobPhase {
  return phaseForOutcome(outcome);
}

export function isJobProgressFault(body: JobProgressBody): body is JobProgressFault {
  return body.kind !== 'message';
}
