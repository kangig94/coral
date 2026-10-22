import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { ProgressSource, ProgressVisitResult, WaitProgressRow } from './wait/contract.js';
import type { Database } from '../store/db.js';
import type { HostRef, UsageSummary } from '../providers/contract.js';

import {
  jobExecutionEndedBodySchema,
  jobExecutionOutcomeAcceptedBodySchema,
  jobDiagnosticsSchema,
  normalizeJobTerminal,
} from './terminal/result.js';
import { jobProgressBodySchema, jobRuntimeStartedBodySchema } from './event-bodies.js';
import { executionOrdinalSchema, jobOpenedBodySchema, jobExecutionRequestedBodySchema } from './launch.js';
import { isLivePhase, type JobPhase } from './phase.js';
import {
  emptyJobDiagnostics,
  isWorkflowJobKind,
  type JobDiagnostics,
  type JobEvent,
  type JobExit,
  type JobLaunch,
  type JobRuntime,
  type JobStatus,
  type JobTerminal,
  type JobTerminalDiagnostics,
} from './records.js';
import { jobInCallerScope } from './scope.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import {
  decodeProjectionJobStoredRow,
  decodeProjectionJobExecutionOwner,
  PROJECTION_JOB_COLUMNS,
  type ProjectionJobStoredRow,
} from './projection-row.js';
import { decodeBody, decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import { rowToCoralEvent } from '../store/envelope.js';
import { prepareCached, sqlPlaceholders } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import { aggregateWorkflowUsage } from './workflow-usage.js';

export type JobProjectionDetail = {
  finishing?: boolean;
  status: JobStatus | null;
  launch: JobLaunch | null;
  runtime: JobRuntime | null;
  exit: JobExit | null;
};

/** What a wait reads of a job: its launch body, which can be arbitrarily large, is never part of it. */
export type JobWaitDetail = Omit<JobProjectionDetail, 'launch'>;

type JobLaunchProjection = JobLaunch;

type JobCliRuntimeProjection = {
  transport: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  tailWatermark?: number;
};

type JobAppServerRuntimeProjection =
  | {
      transport: 'app-server';
      startTime: string;
      providerMeta: {
        provider: string;
        leaseState: 'waiting';
      };
    }
  | {
      transport: 'app-server';
      startTime: string;
      providerMeta: {
        provider: string;
        leaseState: 'acquired';
        hostRef: HostRef;
      };
    };

type JobInternalRuntimeProjection = {
  transport: 'internal';
  operation: 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';
  owner?: 'parent' | 'kb-daemon';
  startTime: string;
};

type JobWorkflowRuntimeProjection = {
  transport: 'workflow';
  startTime: string;
};

type JobRuntimeProjection =
  | JobCliRuntimeProjection
  | JobAppServerRuntimeProjection
  | JobInternalRuntimeProjection
  | JobWorkflowRuntimeProjection
  | null;

type JobExitProjection = {
  outcome: JobTerminal['outcome'];
  content: string;
  durationMs: number;
  diagnostics: JobDiagnostics;
  endTime: string;
};

type ProjectionRow = ProjectionJobStoredRow;

type EventRow = Pick<EventsRow, 'seq' | 'ts' | 'type' | 'stream_kind' | 'body'> & { refs?: EventsRow['refs'] };
type DecodedTerminalRow = {
  record: JobTerminal;
  diagnostics: JobTerminalDiagnostics;
};

export type JobsListFilters = {
  owner?: string;
  unwaited?: boolean;
  projectRoot?: CanonicalWorkDir;
  phase?: JobPhase;
  all?: boolean;
  provider?: string;
};

export type JobDetail = {
  status: JobStatus;
  events: JobEvent[];
};

function emptyJobProjectionDetail(): JobProjectionDetail {
  return {
    finishing: false,
    status: null,
    launch: null,
    runtime: null,
    exit: null,
  };
}

function readProjectionRow(db: Database, jobId: string, observation?: RecoveryObservation): ProjectionRow | null {
  const row = prepareCached<[string], unknown>(
    db,
    `SELECT ${PROJECTION_JOB_COLUMNS}
       FROM projection_jobs
      WHERE job_id = ?`,
  ).get(jobId);

  observation?.record('job-projections', { reads: row === undefined ? 0 : 1 });
  return row === undefined ? null : decodeProjectionJobStoredRow(row);
}

function readProjectionRows(db: Database, jobIds: string[]): Map<string, ProjectionRow> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const rows = prepareCached<unknown[], unknown>(
    db,
    `SELECT ${PROJECTION_JOB_COLUMNS}
       FROM projection_jobs
      WHERE job_id IN (${sqlPlaceholders(jobIds.length)})`,
  ).all(...jobIds);

  const projectionsByJob = new Map<string, ProjectionRow>();
  for (const row of rows) {
    const decoded = decodeProjectionJobStoredRow(row);
    projectionsByJob.set(decoded.job_id, decoded);
  }
  return projectionsByJob;
}

function readOrderedProjectionRows(db: Database, filters?: JobsListFilters): ProjectionRow[] {
  const rows = prepareCached<[], unknown>(
    db,
    `SELECT ${PROJECTION_JOB_COLUMNS}
       FROM projection_jobs
      ORDER BY job_id ASC`,
  )
    .all()
    .map(decodeProjectionJobStoredRow);

  return rows.filter((row) => {
    if (filters && filters.all !== true && !isLivePhase(row.phase)) return false;
    if (
      filters?.projectRoot !== undefined &&
      !jobInCallerScope({ jobKind: row.job_kind, workDir: row.work_dir }, filters.projectRoot, 'exact')
    ) {
      return false;
    }
    if (filters?.phase !== undefined && row.phase !== filters.phase) return false;
    if (filters?.provider !== undefined && row.provider !== filters.provider) return false;
    return true;
  });
}

const EXECUTION_DETAIL_TYPES = [
  'job.execution.requested',
  'job.provider_failed',
  'job.execution.started',
  'job.execution.outcome.accepted',
  'job.execution.ended',
] as const;

function readExecutionDetailEvents(db: Database, jobIds: string[], waitOnly = false): EventsRow[] {
  if (jobIds.length === 0) return [];
  const types = waitOnly
    ? EXECUTION_DETAIL_TYPES.filter((type) => type !== 'job.execution.requested')
    : EXECUTION_DETAIL_TYPES;
  return prepareCached<unknown[], EventsRow>(
    db,
    `
    SELECT e.* FROM events e JOIN projection_jobs p ON p.job_id = e.stream_id
    WHERE e.stream_kind = 'job' AND p.job_id IN (${sqlPlaceholders(jobIds.length)})
      AND e.seq <= p.last_seq AND (
        ${waitOnly ? '' : "e.type = 'job.opened' OR"}
        (e.type IN (${sqlPlaceholders(types.length)})
         AND json_extract(CAST(e.body AS TEXT), '$.execution') = p.execution))
    ORDER BY e.seq ASC
  `,
  ).all(...jobIds, ...types);
}

function executionEvents(
  projection: ProjectionRow,
  rows: readonly EventsRow[],
  ctx: StoreReadContext,
): Map<string, EventsRow> {
  const selected = new Map<string, EventsRow>();
  for (const row of rows) {
    if (row.stream_kind !== 'job' || row.stream_id !== projection.job_id) {
      throw new TypeError(`Job event '${row.seq}' names another stream.`);
    }
    rowToCoralEvent(row, null);
    if (row.seq > projection.last_seq) continue;
    if (row.type === 'job.opened') {
      selected.set(row.type, row);
      continue;
    }
    if (!(EXECUTION_DETAIL_TYPES as readonly string[]).includes(row.type)) continue;
    const body = decodeStoredBody(row, ctx) as { execution?: unknown };
    if (executionOrdinalSchema.parse(body.execution) !== projection.execution) continue;
    const previous = selected.get(row.type);
    if (previous === undefined || previous.seq < row.seq) selected.set(row.type, row);
  }
  return selected;
}

function decodeLaunch(
  jobId: string,
  opened: EventRow | null,
  requested: EventRow | null,
  ctx: StoreReadContext,
): JobLaunchProjection | null {
  if (opened === null || requested === null) return null;
  const job = decodeBody(opened, jobOpenedBodySchema, ctx);
  const request = decodeBody(requested, jobExecutionRequestedBodySchema, ctx);
  const common = {
    jobId,
    owner: job.owner,
    sessionId: null,
    projectRoot: job.projectRoot,
    backendNamespace: request.backendNamespace,
    bundleHash: request.bundleHash,
    pool: request.pool,
    enqueueSequence: request.enqueueSequence,
    execution: request.execution,
    createdAt: request.createdAt,
  };
  if (job.jobKind === 'kb') {
    if (typeof request.input === 'string') throw new TypeError('KB execution requires a KB input.');
    return { ...common, jobKind: 'kb', provider: null, ...request.input };
  }
  if (typeof request.input !== 'string') throw new TypeError('Provider and workflow executions require text input.');
  if (job.jobKind === 'workflow') {
    return {
      ...common,
      jobKind: 'workflow',
      provider: null,
      request: {
        prompt: request.input,
        cwd: job.cwd,
        bypassPermissions: job.bypassPermissions,
        coralEnv: { ...request.coralEnv },
      },
    };
  }
  const {
    provider,
    binding: _binding,
    agent: _agent,
    controllerProfile: _controllerProfile,
    ...facet
  } = job.conversation;
  return {
    ...common,
    jobKind: 'provider',
    provider,
    providerAction: request.action,
    ...(request.discussionRun === undefined ? {} : { discussionRun: request.discussionRun }),
    ...(job.workflowSlotId === undefined ? {} : { workflowSlotId: job.workflowSlotId }),
    ...(job.owner.kind === 'workflow' ? { parentWorkflowJobId: job.owner.id } : {}),
    request: { ...facet, prompt: request.input, coralEnv: { ...request.coralEnv } },
  };
}

function jobRuntimeBodyFromEvent(row: EventRow, ctx: StoreReadContext): JobRuntimeProjection {
  const parsed = decodeBody(row, jobRuntimeStartedBodySchema, ctx);
  if (parsed.transport === 'app-server') {
    if (parsed.providerMeta.leaseState === 'waiting') {
      return {
        transport: 'app-server',
        startTime: parsed.startedAt,
        providerMeta: {
          provider: parsed.providerMeta.provider,
          leaseState: 'waiting',
        },
      };
    }
    return {
      transport: 'app-server',
      startTime: parsed.startedAt,
      providerMeta: {
        provider: parsed.providerMeta.provider,
        leaseState: 'acquired',
        hostRef: parsed.providerMeta.hostRef,
      },
    };
  }

  if (parsed.transport === 'internal') {
    if (
      parsed.operation !== 'kb.source_import' &&
      parsed.operation !== 'kb.reindex' &&
      parsed.operation !== 'kb.community_summary'
    ) {
      throw new Error('Internal job runtime requires a KB operation.');
    }
    return {
      transport: 'internal',
      operation: parsed.operation,
      owner: parsed.owner,
      startTime: parsed.startedAt,
    };
  }

  if (parsed.transport === 'workflow') {
    return {
      transport: 'workflow',
      startTime: parsed.startedAt,
    };
  }

  return {
    transport: 'durable-cli',
    pid: parsed.pid,
    stdoutPath: parsed.stdoutPath,
    stderrPath: parsed.stderrPath,
    startTime: parsed.startedAt,
    tailWatermark: parsed.tailWatermark,
  };
}

function mergeDiagnostics(base: JobDiagnostics, patch: JobTerminalDiagnostics): JobDiagnostics {
  const warnings = patch.warnings ?? base.warnings;
  const usage = patch.usage ?? base.usage;
  const processExit = patch.processExit ?? base.processExit;
  const byteCounts = patch.byteCounts ?? base.byteCounts;
  return {
    progressFaults: base.progressFaults.map((fault) => ({ ...fault })),
    ...(warnings === undefined ? {} : { warnings: [...warnings] }),
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...(processExit === undefined ? {} : { processExit: { ...processExit } }),
    ...(byteCounts === undefined ? {} : { byteCounts: { ...byteCounts } }),
  };
}

function decodeProjectionDiagnostics(projection: ProjectionRow | null): JobDiagnostics {
  if (projection === null) {
    return emptyJobDiagnostics();
  }
  return jobDiagnosticsSchema.parse(JSON.parse(projection.diagnostics));
}

function decodeTerminalRecord(
  row: EventRow | null,
  accepted: EventRow | null,
  jobId: string,
  ctx: StoreReadContext,
): DecodedTerminalRow | null {
  if (row === null) return null;
  const end = decodeBody(row, jobExecutionEndedBodySchema, ctx);
  if (
    accepted === null ||
    end.causeRef.stream.kind !== 'job' ||
    end.causeRef.stream.id !== jobId ||
    end.causeRef.seq !== accepted.seq
  ) {
    throw new TypeError(`Execution end '${row.seq}' does not cite its accepted outcome.`);
  }
  const body = decodeBody(accepted, jobExecutionOutcomeAcceptedBodySchema, ctx);
  if (body.execution !== end.execution) throw new TypeError('Execution end cites another execution.');
  return { record: normalizeJobTerminal(body.terminal), diagnostics: body.diagnostics ?? {} };
}

function toJobExitProjection(
  row: EventRow,
  terminal: DecodedTerminalRow,
  diagnostics: JobDiagnostics,
): JobExitProjection {
  return {
    ...terminal.record,
    durationMs: terminal.record.durationMs,
    diagnostics,
    endTime: row.ts,
  };
}

function applyWorkflowUsage(diagnostics: JobDiagnostics, usage: UsageSummary | undefined): JobDiagnostics {
  return {
    progressFaults: diagnostics.progressFaults.map((fault) => ({ ...fault })),
    ...(diagnostics.warnings === undefined ? {} : { warnings: [...diagnostics.warnings] }),
    ...(diagnostics.processExit === undefined ? {} : { processExit: { ...diagnostics.processExit } }),
    ...(diagnostics.byteCounts === undefined ? {} : { byteCounts: { ...diagnostics.byteCounts } }),
    ...(usage === undefined ? {} : { usage: { ...usage } }),
  };
}

function projectionRowToStatus(
  projection: ProjectionRow,
  events: ReadonlyMap<string, EventsRow>,
  requestedAt: string | null,
  ctx: StoreReadContext,
): JobStatus {
  const terminal = events.get('job.execution.ended') ?? null;
  const accepted = events.get('job.execution.outcome.accepted') ?? null;
  const terminalRecord = decodeTerminalRecord(terminal, accepted, projection.job_id, ctx);
  return {
    jobId: projection.job_id,
    execution: projection.execution,
    finishing: projection.finishing === 1,
    owner: decodeProjectionJobExecutionOwner(projection),
    sessionId: null,
    provider: projection.provider,
    projectRoot: projection.project_root,
    workDir: projection.work_dir,
    backendNamespace: projection.backend_namespace,
    ...(projection.bundle_hash === null ? {} : { bundleHash: projection.bundle_hash }),
    jobKind: projection.job_kind,
    ...(projection.parent_workflow_job_id === null ? {} : { parentWorkflowJobId: projection.parent_workflow_job_id }),
    ...(projection.workflow_slot === null ? {} : { workflowSlotId: projection.workflow_slot }),
    phase: projection.phase,
    updatedAt:
      terminal?.ts ??
      accepted?.ts ??
      events.get('job.execution.started')?.ts ??
      events.get('job.provider_failed')?.ts ??
      requestedAt ??
      projection.created_at,
    lastSeq: projection.last_seq,
    ...(terminalRecord === null ? {} : { result: terminalRecord.record }),
  };
}

function hydrateJobWaitDetail(
  projection: ProjectionRow,
  events: ReadonlyMap<string, EventsRow>,
  requestedAt: string | null,
  ctx: StoreReadContext,
  workflowUsage?: UsageSummary,
): JobWaitDetail {
  const end = events.get('job.execution.ended') ?? null;
  const terminalRecord = decodeTerminalRecord(
    end,
    events.get('job.execution.outcome.accepted') ?? null,
    projection.job_id,
    ctx,
  );
  const terminalDiagnostics =
    terminalRecord === null
      ? decodeProjectionDiagnostics(projection)
      : mergeDiagnostics(decodeProjectionDiagnostics(projection), terminalRecord.diagnostics);
  const diagnostics = isWorkflowJobKind(projection.job_kind)
    ? applyWorkflowUsage(terminalDiagnostics, workflowUsage)
    : terminalDiagnostics;
  const runtime = events.get('job.execution.started');
  return {
    finishing: projection.finishing === 1,
    status: projectionRowToStatus(projection, events, requestedAt, ctx),
    runtime: runtime === undefined ? null : jobRuntimeBodyFromEvent(runtime, ctx),
    exit: end === null || terminalRecord === null ? null : toJobExitProjection(end, terminalRecord, diagnostics),
  };
}

/** Hydrates the projection's execution; absent execution evidence must stay absent. */
export function hydrateJobProjectionDetailFromEvents(
  projection: ProjectionRow,
  rows: readonly EventsRow[],
  ctx: StoreReadContext,
  workflowUsage?: UsageSummary,
): JobProjectionDetail {
  const events = executionEvents(projection, rows, ctx);
  const requested = events.get('job.execution.requested') ?? null;
  const detail = hydrateJobWaitDetail(projection, events, requested?.ts ?? null, ctx, workflowUsage);
  return { ...detail, launch: decodeLaunch(projection.job_id, events.get('job.opened') ?? null, requested, ctx) };
}

export function loadJobProjectionDetail(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
  observation?: RecoveryObservation,
): JobProjectionDetail {
  const projection = readProjectionRow(db, jobId, observation);
  if (projection === null) return emptyJobProjectionDetail();
  const rows = readExecutionDetailEvents(db, [jobId]);
  observation?.record('job-details', { reads: rows.length });
  return hydrateJobProjectionDetailFromEvents(
    projection,
    rows,
    ctx,
    isWorkflowJobKind(projection.job_kind) ? aggregateWorkflowUsage(db, jobId, observation) : undefined,
  );
}

/** The job's own projection sequence: every event of that job moves it, and nothing else does. */
export function readJobLastSeq(db: Database, jobId: string): number | null {
  return (
    prepareCached<[string], { last_seq: number }>(db, 'SELECT last_seq FROM projection_jobs WHERE job_id = ?').get(
      jobId,
    )?.last_seq ?? null
  );
}

/** A wait avoids loading the execution's input and the conversation facet. */
export function loadJobWaitDetail(db: Database, jobId: string, ctx: StoreReadContext): JobWaitDetail {
  const projection = readProjectionRow(db, jobId);
  if (projection === null) return { finishing: false, status: null, runtime: null, exit: null };
  const requestedAt =
    prepareCached<[string, number | null], { ts: string }>(
      db,
      "SELECT ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ? ORDER BY seq DESC LIMIT 1",
    ).get(jobId, projection.execution)?.ts ?? null;
  const events = executionEvents(projection, readExecutionDetailEvents(db, [jobId], true), ctx);
  return hydrateJobWaitDetail(
    projection,
    events,
    requestedAt,
    ctx,
    events.has('job.execution.ended') && isWorkflowJobKind(projection.job_kind)
      ? aggregateWorkflowUsage(db, jobId)
      : undefined,
  );
}

export function loadJobProjectionDetails(
  db: Database,
  jobIds: string[],
  ctx: StoreReadContext,
): Map<string, JobProjectionDetail> {
  const uniqueJobIds = [...new Set(jobIds)];
  const projections = readProjectionRows(db, uniqueJobIds);
  const rowsByJob = new Map<string, EventsRow[]>();
  for (const row of readExecutionDetailEvents(db, uniqueJobIds)) {
    const rows = rowsByJob.get(row.stream_id) ?? [];
    rows.push(row);
    rowsByJob.set(row.stream_id, rows);
  }
  return new Map(
    uniqueJobIds.map((jobId) => {
      const projection = projections.get(jobId);
      return [
        jobId,
        projection === undefined
          ? emptyJobProjectionDetail()
          : hydrateJobProjectionDetailFromEvents(
              projection,
              rowsByJob.get(jobId) ?? [],
              ctx,
              isWorkflowJobKind(projection.job_kind) ? aggregateWorkflowUsage(db, jobId) : undefined,
            ),
      ];
    }),
  );
}

export function listJobProjections(
  db: Database,
  ctx: StoreReadContext,
  filters?: JobsListFilters,
): Array<{ jobId: string; status: JobStatus }> {
  const projections = readOrderedProjectionRows(db, filters);
  const jobIds = projections.map((row) => row.job_id);
  if (jobIds.length === 0) return [];
  const rowsByJob = new Map<string, EventsRow[]>();
  for (const row of readExecutionDetailEvents(db, jobIds, true)) {
    const rows = rowsByJob.get(row.stream_id) ?? [];
    rows.push(row);
    rowsByJob.set(row.stream_id, rows);
  }
  const requestedTimes = prepareCached<unknown[], { stream_id: string; ts: string }>(
    db,
    `
    SELECT e.stream_id, e.ts FROM events e JOIN projection_jobs p ON p.job_id = e.stream_id
    WHERE e.stream_kind = 'job' AND e.type = 'job.execution.requested'
      AND p.job_id IN (${sqlPlaceholders(jobIds.length)}) AND e.seq <= p.last_seq
      AND json_extract(CAST(e.body AS TEXT), '$.execution') = p.execution
  `,
  ).all(...jobIds);
  const requestedAt = new Map(requestedTimes.map((row) => [row.stream_id, row.ts]));
  return projections.map((projection) => ({
    jobId: projection.job_id,
    status: projectionRowToStatus(
      projection,
      executionEvents(projection, rowsByJob.get(projection.job_id) ?? [], ctx),
      requestedAt.get(projection.job_id) ?? null,
      ctx,
    ),
  }));
}

export function listJobs(
  db: Database,
  filters: JobsListFilters,
  ctx: StoreReadContext,
): Array<{ jobId: string; status: JobStatus }> {
  return listJobProjections(db, ctx, filters);
}

export function loadJobDetail(db: Database, jobId: string, ctx: StoreReadContext): JobDetail | null {
  const detail = loadJobProjectionDetail(db, jobId, ctx);
  const status = detail.status;

  if (status === null) {
    return null;
  }
  return {
    status,
    events: readJobEvents(db, jobId, ctx),
  };
}

export function readJobEvents(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
  terminalOnly = false,
  afterSeq = 0,
  observation?: RecoveryObservation,
): JobEvent[] {
  const rows = prepareCached<[string, number], EventsRow>(
    db,
    `SELECT * FROM events WHERE stream_id = ? AND seq > ?
      AND ${terminalOnly ? "type = 'job.execution.ended'" : "type IN ('job.execution.progress', 'job.execution.ended')"}
      ORDER BY seq ASC`,
  ).all(jobId, afterSeq);

  observation?.record('job-events', { reads: rows.length });
  const projection = readProjectionRow(db, jobId, observation);
  const sessionId = null;

  const events: JobEvent[] = [];
  for (const row of rows) {
    rowToCoralEvent(row, null);
    if (row.type === 'job.execution.progress') {
      const body = decodeBody(row, jobProgressBodySchema, ctx);
      if (body.kind !== 'message') {
        continue;
      }

      events.push({
        jobId,
        sessionId,
        seq: row.seq,
        type: 'progress',
        ts: row.ts,
        message: body.message,
        timing: body.timing,
      });
      continue;
    }

    const end = decodeBody(row, jobExecutionEndedBodySchema, ctx);
    const accepted =
      prepareCached<[number, string], EventsRow>(
        db,
        "SELECT * FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.outcome.accepted'",
      ).get(end.causeRef.seq, jobId) ?? null;
    const terminal = decodeTerminalRecord(row, accepted, jobId, ctx);
    if (terminal === null) {
      throw new Error(`Terminal event ${row.seq} for job ${jobId} has no terminal record.`);
    }

    const usage = isWorkflowJobKind(projection?.job_kind)
      ? aggregateWorkflowUsage(db, jobId, observation)
      : terminal.diagnostics.usage;

    events.push({
      jobId,
      sessionId,
      seq: row.seq,
      type: 'terminal',
      ts: row.ts,
      result: terminal.record,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  return events;
}

function progressRows(rows: readonly EventsRow[], ctx: StoreReadContext): WaitProgressRow[] {
  return rows.map((row) => {
    rowToCoralEvent(row, null);
    const body = decodeBody(row, jobProgressBodySchema, ctx);
    return body.kind === 'message' ? { seq: row.seq, message: body.message, timing: body.timing } : { seq: row.seq };
  });
}

/** Rows committed after the captured frontier must remain unconsumed for the next read. */
export function visitJobProgress<T>(
  db: Database,
  ctx: StoreReadContext,
  read: (source: ProgressSource) => T,
): ProgressVisitResult<T> {
  const frontier =
    prepareCached<[], { seq: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0;
  return {
    kind: 'read',
    value: read({
      frontier: () => frontier,
      after: (jobId, afterSeq, rows) =>
        progressRows(
          prepareCached<[string, number, number, number], EventsRow>(
            db,
            "SELECT * FROM events WHERE type = 'job.execution.progress' AND stream_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
          ).all(jobId, afterSeq, frontier, rows),
          ctx,
        ),
      newest: (jobId, rows) =>
        progressRows(
          prepareCached<[string, number, number], EventsRow>(
            db,
            "SELECT * FROM events WHERE type = 'job.execution.progress' AND stream_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?",
          )
            .all(jobId, frontier, rows)
            .reverse(),
          ctx,
        ),
    }),
  };
}
