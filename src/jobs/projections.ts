import { hashToken } from '../infra/hash.js';
import { sessionControllerFromProfile } from './conversation/entry.js';
import type { Database } from '../store/db.js';
import { decodeEventBody } from '../store/body-codec.js';
import type { CoralEvent } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import { phaseForOutcome } from './outcome.js';
import type { JobOpenedBody, JobExecutionRequestedBody } from './launch.js';
import {
  jobDiagnosticsSchema,
  jobExecutionOutcomeAcceptedBodySchema,
  normalizeJobTerminal,
  type JobExecutionOutcomeAcceptedBody,
  type JobExecutionEndedBody,
} from './terminal/result.js';
import { emptyJobDiagnostics, type JobDiagnostics, type JobTerminalDiagnostics } from './records.js';
import type {
  JobContinuityCheckpointedBody,
  JobProgressBody,
  JobQueueAdmittedBody,
  JobQueueQueuedBody,
  JobRuntimeStartedBody,
} from './event-bodies.js';
import { decodeProjectionJobStoredRow, readProjectionJobRow, type ProjectionJobStoredRow } from './projection-row.js';

type JobProjectionPatch = Partial<Omit<ProjectionJobStoredRow, 'job_id' | 'last_seq'>>;

function writeProjectionJob(db: Database, event: CoralEvent, patch: JobProjectionPatch): void {
  const previous = readProjectionJobRow(db, event.stream.id);
  if (previous === null && event.type !== 'job.opened') {
    throw new TypeError(`Job '${event.stream.id}' must be opened before '${event.type}'.`);
  }
  if (previous !== null && event.type === 'job.opened') {
    throw new TypeError(`Job '${event.stream.id}' is already opened.`);
  }
  const { job_id, last_seq, ...columns } = decodeProjectionJobStoredRow({
    ...previous,
    ...patch,
    job_id: event.stream.id,
    last_seq: event.seq,
  });
  upsertProjection(db, {
    table: 'projection_jobs',
    pkColumn: 'job_id',
    pkValue: job_id,
    columns,
    lastSeq: last_seq,
  });
}

function mergeDiagnostics(current: JobDiagnostics, patch: JobTerminalDiagnostics): JobDiagnostics {
  return jobDiagnosticsSchema.parse({ ...current, ...patch });
}

export const reduceJobOpened: Reducer<JobOpenedBody> = (db, event) => {
  const body = event.body;
  const facet = body.jobKind === 'provider' ? body.conversation : null;
  writeProjectionJob(db, event, {
    execution_owner: JSON.stringify(body.owner),
    execution: null,
    finishing: 0,
    phase: 'launching',
    terminal: null,
    diagnostics: JSON.stringify(emptyJobDiagnostics()),
    provider: facet?.provider ?? null,
    controller: facet === null ? null : sessionControllerFromProfile(facet.controllerProfile),
    resumable: facet === null ? null : 0,
    conversation_ref: null,
    scope_key: facet === null ? null : hashToken(body.projectRoot, 12),
    facet: facet === null ? null : JSON.stringify(facet),
    project_root: body.projectRoot,
    work_dir: facet?.cwd ?? (body.jobKind === 'workflow' ? body.cwd : null),
    backend_namespace: null,
    bundle_hash: null,
    job_kind: body.jobKind,
    parent_workflow_job_id: body.owner.kind === 'workflow' && body.jobKind === 'provider' ? body.owner.id : null,
    workflow_slot: body.jobKind === 'provider' ? (body.workflowSlotId ?? null) : null,
    created_at: body.createdAt,
  });
};

export const reduceJobExecutionRequested: Reducer<JobExecutionRequestedBody> = (db, event) => {
  writeProjectionJob(db, event, {
    execution: event.body.execution,
    phase: 'launching',
    terminal: null,
    diagnostics: JSON.stringify(emptyJobDiagnostics()),
    finishing: 0,
    backend_namespace: event.body.backendNamespace,
    bundle_hash: event.body.bundleHash ?? null,
  });
};

export const reduceJobQueueQueued: Reducer<JobQueueQueuedBody> = (db, event) => {
  writeProjectionJob(db, event, { phase: 'queued' });
};

export const reduceJobQueueAdmitted: Reducer<JobQueueAdmittedBody> = (db, event) => {
  writeProjectionJob(db, event, { phase: 'launching' });
};

export const reduceJobRuntimeStarted: Reducer<JobRuntimeStartedBody> = (db, event) => {
  writeProjectionJob(db, event, { phase: 'running' });
};

export const reduceJobProgress: Reducer<JobProgressBody> = (db, event) => {
  const previous = readProjectionJobRow(db, event.stream.id);
  if (previous === null) throw new TypeError(`Job '${event.stream.id}' is not opened.`);
  const diagnostics = jobDiagnosticsSchema.parse(JSON.parse(previous.diagnostics));
  const { execution: _execution, ...progress } = event.body;
  if (progress.kind !== 'message' && progress.kind !== 'domain') diagnostics.progressFaults.push(progress);
  writeProjectionJob(db, event, { diagnostics: JSON.stringify(diagnostics) });
};

export const reduceJobOutcomeAccepted: Reducer<JobExecutionOutcomeAcceptedBody> = (db, event) => {
  const previous = readProjectionJobRow(db, event.stream.id);
  if (previous === null) throw new TypeError(`Job '${event.stream.id}' is not opened.`);
  writeProjectionJob(db, event, {
    finishing: 1,
    diagnostics: JSON.stringify(
      mergeDiagnostics(jobDiagnosticsSchema.parse(JSON.parse(previous.diagnostics)), event.body.diagnostics ?? {}),
    ),
  });
};

export const reduceJobExecutionEnded: Reducer<JobExecutionEndedBody> = (db, event) => {
  const row = db
    .prepare<
      [number, string],
      { body: Uint8Array }
    >("SELECT body FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.outcome.accepted'")
    .get(event.body.causeRef.seq, event.stream.id);
  if (
    row === undefined ||
    event.body.causeRef.stream.kind !== 'job' ||
    event.body.causeRef.stream.id !== event.stream.id
  ) {
    throw new TypeError(`Execution end '${event.seq}' has no accepted outcome on its job.`);
  }
  const accepted = jobExecutionOutcomeAcceptedBodySchema.parse(decodeEventBody(row.body));
  if (accepted.execution !== event.body.execution) throw new TypeError('Execution end cites another execution.');
  writeProjectionJob(db, event, {
    phase: phaseForOutcome(accepted.terminal.outcome),
    terminal: JSON.stringify(normalizeJobTerminal(accepted.terminal)),
    finishing: 0,
  });
};

export const reduceJobContinuityCheckpointed: Reducer<JobContinuityCheckpointedBody> = (db, event) => {
  writeProjectionJob(db, event, {
    resumable: event.body.snapshot.resumable ? 1 : 0,
    conversation_ref: event.body.snapshot.conversationRef,
  });
};

export const reduceJobObservation: Reducer = (db, event) => {
  writeProjectionJob(db, event, {});
};
