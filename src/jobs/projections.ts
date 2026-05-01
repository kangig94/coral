// Job projection writers + DB-side reducers. Body type imports come from
// per-concept companion files (queue/runtime/progress/outcome/result/launch),
// keeping `events.ts` (registry assembly) cleanly above this file with no
// cycle in either direction.

import type { Database } from 'better-sqlite3';

import { CoralSetupError } from '../runtime/errors.js';
import type { CoralEvent, CoralEventInput } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import type { DomainAppendValidator, Reducer } from '../store/reducers.js';
import type { JobLaunchRequestBody } from './launch.js';
import type { JobPhase } from './phase.js';
import { phaseForOutcome, type JobAbortedBody, type JobLaunchRejected, type JobProgressFault } from './outcome.js';
import {
  jobDiagnosticsSchema,
  jobTerminalSchema,
  normalizeJobTerminal,
  type JobTerminaledBody,
} from './terminal/result.js';
import type { JobDiagnostics, JobTerminal, JobTerminalDiagnostics } from './records.js';
import type {
  JobProgressBody,
  JobQueueAdmittedBody,
  JobQueueQueuedBody,
  JobRuntimeStartedBody,
} from './event-bodies.js';

type ProjectedJobState = {
  phase: JobPhase;
  terminal: JobTerminal | null;
  diagnostics: JobDiagnostics;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash: string | null;
  jobKind: 'provider' | 'workflow' | 'kb';
  parentWorkflowJobId: string | null;
  workflowSlot: string | null;
  createdAt: string;
};

function emptyDiagnostics(): JobDiagnostics {
  return { progressFaults: [] };
}

function terminalDiagnosticsFromBody(body: JobTerminaledBody): JobTerminalDiagnostics {
  return body.diagnostics ?? {};
}

function mergeDiagnostics(current: JobDiagnostics | undefined, patch: JobTerminalDiagnostics): JobDiagnostics {
  const processExit = patch.processExit ?? current?.processExit;
  const byteCounts = patch.byteCounts ?? current?.byteCounts;
  return {
    progressFaults: [...(current?.progressFaults ?? [])],
    ...(patch.warnings === undefined ? {} : { warnings: [...patch.warnings] }),
    ...(patch.usage === undefined ? {} : { usage: { ...patch.usage } }),
    ...(processExit === undefined ? {} : { processExit: { ...processExit } }),
    ...(byteCounts === undefined ? {} : { byteCounts: { ...byteCounts } }),
  };
}

function prematureProjectionJobEvent(event: CoralEvent): CoralSetupError {
  return new CoralSetupError({
    code: 'projection_jobs_premature_event',
    userMessage: `Job projection received '${event.type}' for '${event.stream.id}' before job.launch.requested.`,
    remediation:
      'Append job.launch.requested before any queued, runtime, progress, terminal, or aborted events for a job stream.',
    context: {
      jobId: event.stream.id,
      type: event.type,
      seq: event.seq,
    },
  });
}

type JobTerminalOrderState = { kind: 'existing'; seq: number } | { kind: 'batch' };

function jobTerminalOrderViolation(input: CoralEventInput, state: JobTerminalOrderState): CoralSetupError {
  const reason =
    state.kind === 'existing'
      ? `terminal already recorded at seq ${state.seq}`
      : 'terminal already recorded in this append batch';
  return new CoralSetupError({
    code: 'job_terminal_order_violation',
    userMessage: `Job event '${input.type}' cannot be appended for '${input.stream.id}' after job.terminal.recorded.`,
    remediation: 'Append exactly one job.terminal.recorded event, and keep it as the last event on each job stream.',
    context: {
      jobId: input.stream.id,
      type: input.type,
      reason,
    },
  });
}

function readLatestTerminalSeq(db: Database, jobId: string): number | null {
  const row = db
    .prepare(
      `SELECT seq
         FROM events
        WHERE stream_kind = 'job'
          AND stream_id = ?
          AND type = 'job.terminal.recorded'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId) as { seq: number } | undefined;

  return row?.seq ?? null;
}

export const validateJobTerminalOrder: DomainAppendValidator = (ctx, inputs) => {
  const terminalByJob = new Map<string, JobTerminalOrderState | null>();

  for (const input of inputs) {
    if (input.stream.kind !== 'job') {
      continue;
    }

    const jobId = input.stream.id;
    let terminalState = terminalByJob.get(jobId);
    if (terminalState === undefined) {
      const seq = readLatestTerminalSeq(ctx.db, jobId);
      terminalState = seq === null ? null : { kind: 'existing', seq };
      terminalByJob.set(jobId, terminalState);
    }

    if (terminalState !== null) {
      throw jobTerminalOrderViolation(input, terminalState);
    }

    if (input.type === 'job.terminal.recorded') {
      terminalByJob.set(jobId, { kind: 'batch' });
    }
  }
};

function createInitialProjectionJobState(event: CoralEvent, patch: Partial<ProjectedJobState>): ProjectedJobState {
  if (
    patch.projectRoot === undefined ||
    patch.backendNamespace === undefined ||
    patch.jobKind === undefined ||
    patch.createdAt === undefined
  ) {
    throw prematureProjectionJobEvent(event);
  }

  return {
    phase: patch.phase ?? 'launching',
    terminal: patch.terminal ?? null,
    diagnostics: patch.diagnostics ?? emptyDiagnostics(),
    sessionId: patch.sessionId ?? null,
    provider: patch.provider ?? null,
    projectRoot: patch.projectRoot,
    backendNamespace: patch.backendNamespace,
    bundleHash: patch.bundleHash ?? null,
    jobKind: patch.jobKind,
    parentWorkflowJobId: patch.parentWorkflowJobId ?? event.refs?.parentJobId ?? null,
    workflowSlot: patch.workflowSlot ?? event.refs?.workflowSlotId ?? null,
    createdAt: patch.createdAt,
  };
}

function readProjectionJob(db: Database, jobId: string): ProjectedJobState | null {
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
        session_id: string | null;
        provider: string | null;
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
    diagnostics:
      row.diagnostics === null ? emptyDiagnostics() : jobDiagnosticsSchema.parse(JSON.parse(row.diagnostics)),
    sessionId: row.session_id,
    provider: row.provider,
    projectRoot: row.project_root,
    backendNamespace: row.backend_namespace,
    bundleHash: row.bundle_hash,
    jobKind: row.job_kind as 'provider' | 'workflow' | 'kb',
    parentWorkflowJobId: row.parent_workflow_job_id,
    workflowSlot: row.workflow_slot,
    createdAt: row.created_at,
  };
}

function upsertProjectionJob(db: Database, event: CoralEvent, patch: Partial<ProjectedJobState>): void {
  const previous = readProjectionJob(db, event.stream.id);
  if (!previous && event.type !== 'job.launch.requested') {
    throw prematureProjectionJobEvent(event);
  }

  const base = previous ?? createInitialProjectionJobState(event, patch);
  const next: ProjectedJobState = {
    phase: patch.phase ?? base.phase,
    terminal: patch.terminal ?? base.terminal,
    diagnostics: patch.diagnostics ?? base.diagnostics,
    sessionId: patch.sessionId === undefined ? base.sessionId : patch.sessionId,
    provider: patch.provider === undefined ? base.provider : patch.provider,
    projectRoot: patch.projectRoot ?? base.projectRoot,
    backendNamespace: patch.backendNamespace ?? base.backendNamespace,
    bundleHash: patch.bundleHash ?? base.bundleHash,
    jobKind: patch.jobKind ?? base.jobKind,
    parentWorkflowJobId: patch.parentWorkflowJobId ?? base.parentWorkflowJobId,
    workflowSlot: patch.workflowSlot ?? base.workflowSlot,
    createdAt: patch.createdAt ?? base.createdAt,
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

export const reduceJobLaunchRequested: Reducer<JobLaunchRequestBody> = (db, event) => {
  const sessionId = event.body.jobKind === 'kb' ? null : event.body.sessionId;
  const provider = event.body.jobKind === 'kb' ? null : event.body.provider;
  upsertProjectionJob(db, event, {
    phase: 'launching',
    sessionId,
    provider,
    projectRoot: event.body.projectRoot,
    backendNamespace: event.body.backendNamespace,
    bundleHash: event.body.bundleHash ?? null,
    jobKind: event.body.jobKind,
    parentWorkflowJobId: event.refs?.parentJobId ?? null,
    workflowSlot: event.refs?.workflowSlotId ?? null,
    createdAt: event.body.createdAt,
  });
};

export const reduceJobLaunchRejected: Reducer<JobLaunchRejected> = (db, event) => {
  upsertProjectionJob(db, event, { phase: 'error' });
};

export const reduceJobQueueQueued: Reducer<JobQueueQueuedBody> = (db, event) => {
  upsertProjectionJob(db, event, { phase: 'queued' });
};

export const reduceJobQueueAdmitted: Reducer<JobQueueAdmittedBody> = (db, event) => {
  upsertProjectionJob(db, event, { phase: 'launching' });
};

export const reduceJobRuntimeStarted: Reducer<JobRuntimeStartedBody> = (db, event) => {
  upsertProjectionJob(db, event, { phase: 'running' });
};

export const reduceJobProgress: Reducer<JobProgressBody> = (db, event) => {
  const previous = readProjectionJob(db, event.stream.id);
  if (event.body.kind === 'message' || event.body.kind === 'domain') {
    upsertProjectionJob(db, event, {});
    return;
  }

  const diagnostics: JobDiagnostics = {
    progressFaults: [...(previous?.diagnostics.progressFaults ?? []), event.body as JobProgressFault],
    ...(previous?.diagnostics.warnings === undefined ? {} : { warnings: [...previous.diagnostics.warnings] }),
    ...(previous?.diagnostics.usage === undefined ? {} : { usage: { ...previous.diagnostics.usage } }),
    ...(previous?.diagnostics.processExit === undefined
      ? {}
      : { processExit: { ...previous.diagnostics.processExit } }),
    ...(previous?.diagnostics.byteCounts === undefined ? {} : { byteCounts: { ...previous.diagnostics.byteCounts } }),
  };

  upsertProjectionJob(db, event, { diagnostics });
};

export const reduceJobTerminal: Reducer<JobTerminaledBody> = (db, event) => {
  const previous = readProjectionJob(db, event.stream.id);
  const terminal = normalizeJobTerminal(event.body.terminal);
  const diagnostics = mergeDiagnostics(previous?.diagnostics, terminalDiagnosticsFromBody(event.body));
  upsertProjectionJob(db, event, {
    phase: phaseForOutcome(event.body.terminal.outcome),
    terminal,
    diagnostics,
  });
};

export const reduceJobAborted: Reducer<JobAbortedBody> = (db, event) => {
  upsertProjectionJob(db, event, { phase: 'aborted' });
};
