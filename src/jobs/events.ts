import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { MAX_BUFFER } from '../shared/process-constants.js';
import type { CoralEvent } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
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
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash: string | null;
  jobKind: 'provider' | 'workflow';
  parentWorkflowJobId: string | null;
  workflowSlot: string | null;
  createdAt: string;
};

function emptyDiagnostics(): JobDiagnostics {
  return { progressFaults: [] };
}

function readProjectionJob(db: Database, jobId: string): ProjectionJobRow | null {
  const row = db
    .prepare(
      `SELECT phase, terminal, diagnostics,
              session_id, provider, project_root, backend_namespace, bundle_hash,
              job_kind, parent_workflow_job_id, workflow_slot, created_at
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as
    | {
        phase: string;
        terminal: string | null;
        diagnostics: string | null;
        session_id: string;
        provider: string;
        project_root: string;
        backend_namespace: string;
        bundle_hash: string | null;
        job_kind: string;
        parent_workflow_job_id: string | null;
        workflow_slot: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    phase: row.phase as JobPhase,
    terminal: row.terminal === null ? null : jobTerminalSchema.parse(JSON.parse(row.terminal)),
    diagnostics: row.diagnostics === null ? emptyDiagnostics() : jobDiagnosticsSchema.parse(JSON.parse(row.diagnostics)),
    sessionId: row.session_id,
    provider: row.provider,
    projectRoot: row.project_root,
    backendNamespace: row.backend_namespace,
    bundleHash: row.bundle_hash,
    jobKind: row.job_kind as 'provider' | 'workflow',
    parentWorkflowJobId: row.parent_workflow_job_id,
    workflowSlot: row.workflow_slot,
    createdAt: row.created_at,
  };
}

function upsertProjectionJob(
  db: Database,
  event: CoralEvent,
  patch: Partial<ProjectionJobRow>,
): void {
  const previous = readProjectionJob(db, event.stream.id);
  // Identity fields are populated by reducerForRequested. If a non-launch event
  // fires before launch.requested (expected only in test fixtures that stage
  // runtime/terminal events directly), we fall back to empty strings — the
  // projection row still writes but identity filters won't match until a real
  // launch event arrives.
  const next: ProjectionJobRow = {
    phase: patch.phase ?? previous?.phase ?? ('launching' as JobPhase),
    terminal: patch.terminal ?? previous?.terminal ?? null,
    diagnostics: patch.diagnostics ?? previous?.diagnostics ?? emptyDiagnostics(),
    sessionId: patch.sessionId ?? previous?.sessionId ?? '',
    provider: patch.provider ?? previous?.provider ?? '',
    projectRoot: patch.projectRoot ?? previous?.projectRoot ?? '',
    backendNamespace: patch.backendNamespace ?? previous?.backendNamespace ?? '',
    bundleHash: patch.bundleHash ?? previous?.bundleHash ?? null,
    jobKind: patch.jobKind ?? previous?.jobKind ?? 'provider',
    parentWorkflowJobId:
      patch.parentWorkflowJobId ?? previous?.parentWorkflowJobId ?? (event.refs?.parentJobId ?? null),
    workflowSlot:
      patch.workflowSlot ?? previous?.workflowSlot ?? (event.refs?.workflowSlotId ?? null),
    createdAt: patch.createdAt ?? previous?.createdAt ?? event.ts,
  };

  upsertProjection(db, {
    table: 'projection_jobs',
    pkColumn: 'job_id',
    pkValue: event.stream.id,
    columns: {
      phase: next.phase,
      terminal: next.terminal === null ? null : JSON.stringify(next.terminal),
      diagnostics: JSON.stringify(next.diagnostics),
      session_id: next.sessionId,
      provider: next.provider,
      project_root: next.projectRoot,
      backend_namespace: next.backendNamespace,
      bundle_hash: next.bundleHash,
      job_kind: next.jobKind,
      parent_workflow_job_id: next.parentWorkflowJobId,
      workflow_slot: next.workflowSlot,
      created_at: next.createdAt,
    },
    lastSeq: event.seq,
  });
}

function reducerForRequested(): Reducer<JobLaunchRequestBody> {
  return (db, event) => {
    upsertProjectionJob(db, event, {
      phase: 'launching',
      sessionId: event.body.sessionId,
      provider: event.body.provider,
      projectRoot: event.body.projectRoot,
      backendNamespace: event.body.backendNamespace,
      bundleHash: event.body.bundleHash ?? null,
      jobKind: event.body.jobKind ?? 'provider',
      parentWorkflowJobId: event.body.parentJobId ?? event.refs?.parentJobId ?? null,
      workflowSlot: event.body.workflowSlot ?? event.refs?.workflowSlotId ?? null,
      createdAt: event.body.createdAt,
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
