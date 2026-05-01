import type BetterSqlite3 from 'better-sqlite3';

import type { JobContinuitySnapshot } from './continuity.js';
import { jobTerminalRecordedBodySchema, jobDiagnosticsSchema, normalizeJobTerminal } from './terminal/result.js';
import { jobProgressBodySchema, jobRuntimeStartedBodySchema } from './event-bodies.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { type JobPhase } from './phase.js';
import type { JobProjectionDetail } from './read-contract.js';
import {
  belongsToNamespace,
  emptyJobDiagnostics,
  type JobDiagnostics,
  type JobEvent,
  type JobStatus,
  type JobTerminal,
  type JobTerminalDiagnostics,
} from './records.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { prepareCached } from '../store/db.js';
import { readLatestEvent } from '../store/event-queries.js';
import type { EventsRow } from '../store/schema.js';

type JobLaunchProjection = {
  jobId: string;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: 'provider' | 'workflow' | 'kb';
  pool: string;
  enqueueSequence: number;
  providerAction?: 'exec' | 'resume' | 'fork';
  operation?: 'kb.source_import' | 'kb.reindex';
  request:
    | {
        prompt: string;
        name?: string;
        model?: string;
        cwd: string;
        effort?: string;
        bypassPermissions: boolean;
        systemPrompt?: string;
        conversationRef?: string;
        instruction?: {
          content: string;
          channel: 'prompt' | 'system';
        };
        coralEnv: Record<string, string>;
      }
    | {
        filePath: string;
        slug?: string;
        readiness: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
      }
    | Record<string, never>;
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
  createdAt: string;
};

type JobCliRuntimeProjection = {
  transport?: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  providerMeta?: Record<string, unknown>;
  tailWatermark?: number;
};

type JobAppServerRuntimeProjection = {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    providerContinuity?: Record<string, unknown>;
  };
};

type JobInternalRuntimeProjection = {
  transport: 'internal';
  operation: 'kb.source_import' | 'kb.reindex';
  startTime: string;
};

type JobRuntimeProjection =
  | JobCliRuntimeProjection
  | JobAppServerRuntimeProjection
  | JobInternalRuntimeProjection
  | null;

type JobExitProjection = {
  outcome: JobTerminal['outcome'];
  content: string;
  durationMs: number;
  diagnostics: JobDiagnostics;
  endTime: string;
  continuity?: JobContinuitySnapshot | null;
};

type JobProgressProjection = {
  jobId: string;
  sessionId: string | null;
  seq: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminal;
  continuity?: JobContinuitySnapshot | null;
};

type ProjectionRow = {
  job_id: string;
  phase: string;
  terminal: string | null;
  diagnostics: string | null;
  session_id: string | null;
  provider: string | null;
  project_root: string;
  backend_namespace: string;
  bundle_hash: string | null;
  job_kind: 'provider' | 'workflow' | 'kb';
  parent_workflow_job_id: string | null;
  workflow_slot: string | null;
  created_at: string;
  last_seq: number;
};

type EventRow = Pick<EventsRow, 'seq' | 'ts' | 'type' | 'body_version' | 'body'> & { refs?: EventsRow['refs'] };
type LatestJobEventProjection = EventRow & { stream_id: string };
type ProjectionStatusEventType = 'job.launch.rejected' | 'job.runtime.started' | 'job.terminal.recorded';
type JobStatusEventsByType = {
  rejected: EventRow | null;
  runtime: EventRow | null;
  terminal: EventRow | null;
};
type DecodedTerminalRow = {
  record: JobTerminal;
  diagnostics: JobTerminalDiagnostics;
  continuity: JobContinuitySnapshot | null;
};

const LIVE_JOB_PHASES = ['queued', 'launching', 'running'] as const;

export type JobsListFilters = {
  projectRoot?: string;
  phase?: JobPhase;
  all?: boolean;
  provider?: string;
  namespace?: string;
};

export type JobDetail = {
  status: JobStatus;
  events: JobEvent[];
};

function emptyJobProjectionDetail(): JobProjectionDetail {
  return {
    status: null,
    launch: null,
    runtime: null,
    exit: null,
  };
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readProjectionRow(db: BetterSqlite3.Database, jobId: string): ProjectionRow | null {
  const row = prepareCached<[string], ProjectionRow | undefined>(
    db,
    `SELECT job_id, phase, terminal, diagnostics,
            session_id, provider, project_root, backend_namespace, bundle_hash,
            job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
       FROM projection_jobs
      WHERE job_id = ?`,
  ).get(jobId);

  return row ?? null;
}

function readProjectionRows(db: BetterSqlite3.Database, jobIds: string[]): Map<string, ProjectionRow> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const rows = prepareCached<unknown[], ProjectionRow>(
    db,
    `SELECT job_id, phase, terminal, diagnostics,
            session_id, provider, project_root, backend_namespace, bundle_hash,
            job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
       FROM projection_jobs
      WHERE job_id IN (${sqlPlaceholders(jobIds.length)})`,
  ).all(...jobIds);

  return new Map(rows.map((row) => [row.job_id, row]));
}

function readOrderedProjectionRows(db: BetterSqlite3.Database, filters?: JobsListFilters): ProjectionRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters?.namespace !== undefined) {
    clauses.push('backend_namespace = ?');
    params.push(filters.namespace);
  }
  if (filters && filters.all !== true) {
    clauses.push(`phase IN (${sqlPlaceholders(LIVE_JOB_PHASES.length)})`);
    params.push(...LIVE_JOB_PHASES);
  }
  if (filters?.projectRoot !== undefined) {
    clauses.push('project_root = ?');
    params.push(filters.projectRoot);
  }
  if (filters?.phase !== undefined) {
    clauses.push('phase = ?');
    params.push(filters.phase);
  }
  if (filters?.provider !== undefined) {
    clauses.push('provider = ?');
    params.push(filters.provider);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return prepareCached<unknown[], ProjectionRow>(
    db,
    `SELECT job_id, phase, terminal, diagnostics,
            session_id, provider, project_root, backend_namespace, bundle_hash,
            job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
       FROM projection_jobs
      ${whereClause}
      ORDER BY job_id ASC`,
  ).all(...params);
}

function readLatestEventsForJobs(db: BetterSqlite3.Database, jobIds: string[], type: string): Map<string, EventRow> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const rows = prepareCached<unknown[], LatestJobEventProjection>(
    db,
    `SELECT stream_id, seq, ts, type, refs, body_version, body
       FROM events
      WHERE stream_kind = 'job'
        AND type = ?
        AND stream_id IN (${sqlPlaceholders(jobIds.length)})
      ORDER BY stream_id ASC, seq DESC`,
  ).all(type, ...jobIds);

  const eventsByJob = new Map<string, EventRow>();
  for (const row of rows) {
    if (eventsByJob.has(row.stream_id)) {
      continue;
    }

    eventsByJob.set(row.stream_id, {
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      refs: row.refs,
      body_version: row.body_version,
      body: row.body,
    });
  }

  return eventsByJob;
}

function readLatestProjectionStatusEvents(
  db: BetterSqlite3.Database,
  jobIds: string[],
): Map<string, JobStatusEventsByType> {
  const eventsByJob = new Map<string, JobStatusEventsByType>();
  if (jobIds.length === 0) {
    return eventsByJob;
  }

  const rows = prepareCached<unknown[], LatestJobEventProjection & { type: ProjectionStatusEventType }>(
    db,
    `SELECT stream_id, type, seq, ts, refs, body_version, body
       FROM (
         SELECT stream_id, type, seq, ts, refs, body_version, body,
                ROW_NUMBER() OVER (PARTITION BY stream_id, type ORDER BY seq DESC) AS row_number
           FROM events
          WHERE stream_kind = 'job'
            AND type IN ('job.launch.rejected', 'job.runtime.started', 'job.terminal.recorded')
            AND stream_id IN (${sqlPlaceholders(jobIds.length)})
       )
      WHERE row_number = 1`,
  ).all(...jobIds);

  for (const row of rows) {
    const current = eventsByJob.get(row.stream_id) ?? {
      rejected: null,
      runtime: null,
      terminal: null,
    };

    if (row.type === 'job.launch.rejected') {
      current.rejected = row;
    } else if (row.type === 'job.runtime.started') {
      current.runtime = row;
    } else {
      current.terminal = row;
    }

    eventsByJob.set(row.stream_id, current);
  }

  return eventsByJob;
}

function decodeLaunchRefs(row: EventRow): Pick<JobLaunchProjection, 'parentWorkflowJobId' | 'workflowSlotId'> {
  if (row.refs === undefined || row.refs === null) {
    return {};
  }

  const refs = JSON.parse(row.refs) as Record<string, unknown>;
  return {
    ...(typeof refs.parentJobId === 'string' ? { parentWorkflowJobId: refs.parentJobId } : {}),
    ...(typeof refs.workflowSlotId === 'string' ? { workflowSlotId: refs.workflowSlotId } : {}),
  };
}

function decodeLaunch(jobId: string, row: EventRow | null, ctx: StoreReadContext): JobLaunchProjection | null {
  if (!row) {
    return null;
  }

  const body = decodeBody(row, jobLaunchRequestBodySchema, ctx);
  const refs = decodeLaunchRefs(row);
  if (body.jobKind === 'kb') {
    const request =
      body.operation === 'kb.source_import'
        ? {
            filePath: body.request.filePath,
            ...(body.request.slug === undefined ? {} : { slug: body.request.slug }),
            readiness: body.request.readiness,
          }
        : {};
    return {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot: body.projectRoot,
      backendNamespace: body.backendNamespace,
      bundleHash: body.bundleHash,
      jobKind: body.jobKind,
      pool: body.pool,
      enqueueSequence: body.enqueueSequence,
      operation: body.operation,
      request,
      ...refs,
      createdAt: body.createdAt,
    };
  }

  return {
    jobId,
    sessionId: body.sessionId,
    provider: body.provider,
    projectRoot: body.projectRoot,
    backendNamespace: body.backendNamespace,
    bundleHash: body.bundleHash,
    jobKind: body.jobKind,
    pool: body.pool,
    enqueueSequence: body.enqueueSequence,
    providerAction: body.providerAction,
    request: {
      prompt: body.request.prompt,
      name: body.request.name,
      model: body.request.model,
      cwd: body.request.cwd,
      effort: body.request.effort,
      bypassPermissions: body.request.bypassPermissions,
      systemPrompt: body.request.systemPrompt,
      conversationRef: body.request.conversationRef,
      instruction: body.request.instruction,
      coralEnv: { ...body.request.coralEnv },
    },
    ...refs,
    createdAt: body.createdAt,
  };
}

function jobRuntimeBodyFromEvent(row: EventRow, ctx: StoreReadContext): JobRuntimeProjection {
  const parsed = decodeBody(row, jobRuntimeStartedBodySchema, ctx);
  if (parsed.transport === 'app-server') {
    const providerMeta = parsed.providerMeta;
    return {
      transport: 'app-server',
      startTime: parsed.startedAt,
      providerMeta: {
        provider: typeof providerMeta?.provider === 'string' ? providerMeta.provider : '',
        leaseState: providerMeta?.leaseState === 'acquired' ? 'acquired' : 'waiting',
        serverGeneration:
          typeof providerMeta?.serverGeneration === 'number' ? providerMeta.serverGeneration : undefined,
        providerContinuity:
          providerMeta?.providerContinuity && typeof providerMeta.providerContinuity === 'object'
            ? (providerMeta.providerContinuity as Record<string, unknown>)
            : undefined,
      },
    };
  }

  if (parsed.transport === 'internal') {
    if (parsed.operation !== 'kb.source_import' && parsed.operation !== 'kb.reindex') {
      throw new Error('Internal job runtime requires a KB operation.');
    }
    return {
      transport: 'internal',
      operation: parsed.operation,
      startTime: parsed.startedAt,
    };
  }

  return {
    transport: parsed.transport === 'durable-cli' ? 'durable-cli' : undefined,
    pid: parsed.pid ?? 0,
    stdoutPath: parsed.stdoutPath ?? '',
    stderrPath: parsed.stderrPath ?? '',
    startTime: parsed.startedAt,
    providerMeta: parsed.providerMeta,
    tailWatermark: parsed.tailWatermark,
  };
}

function mergeDiagnostics(base: JobDiagnostics, patch: JobTerminalDiagnostics): JobDiagnostics {
  const warnings = patch.warnings ?? base.warnings;
  const usage = patch.usage ?? base.usage;
  const processExit = patch.processExit ?? base.processExit;
  return {
    progressFaults: base.progressFaults.map((fault) => ({ ...fault })),
    ...(warnings === undefined ? {} : { warnings: [...warnings] }),
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...(processExit === undefined ? {} : { processExit: { ...processExit } }),
  };
}

function decodeProjectionDiagnostics(projection: ProjectionRow | null): JobDiagnostics {
  if (projection?.diagnostics === null || projection?.diagnostics === undefined) {
    return emptyJobDiagnostics();
  }
  return jobDiagnosticsSchema.parse(JSON.parse(projection.diagnostics));
}

function decodeTerminalRecord(row: EventRow | null, ctx: StoreReadContext): DecodedTerminalRow | null {
  if (!row) {
    return null;
  }

  const body = decodeBody(row, jobTerminalRecordedBodySchema, ctx);
  return {
    record: normalizeJobTerminal(body.terminal),
    diagnostics: body.diagnostics ?? {},
    continuity: body.continuity ?? null,
  };
}

function toJobExitProjection(
  row: EventRow,
  terminal: DecodedTerminalRow,
  diagnostics: JobDiagnostics,
): JobExitProjection {
  return {
    ...terminal.record,
    durationMs: terminal.record.durationMs ?? 0,
    diagnostics,
    continuity: terminal.continuity,
    endTime: row.ts,
  };
}

function projectionRowToStatus(
  jobId: string,
  projection: ProjectionRow,
  rejected: EventRow | null,
  runtime: EventRow | null,
  terminal: EventRow | null,
  requested: EventRow | null,
  ctx: StoreReadContext,
): JobStatus {
  const terminalRecord = decodeTerminalRecord(terminal, ctx);

  return {
    jobId,
    sessionId: projection.session_id,
    provider: projection.provider,
    projectRoot: projection.project_root,
    backendNamespace: projection.backend_namespace,
    ...(projection.bundle_hash === null ? {} : { bundleHash: projection.bundle_hash }),
    jobKind: projection.job_kind,
    phase: projection.phase as JobPhase,
    updatedAt: terminal?.ts ?? runtime?.ts ?? rejected?.ts ?? requested?.ts ?? projection.created_at,
    lastSeq: projection.last_seq,
    ...(terminalRecord ? { result: terminalRecord.record } : {}),
    ...(terminalRecord ? { continuity: terminalRecord.continuity } : {}),
  };
}

function hydrateJobProjectionDetail(
  jobId: string,
  projection: ProjectionRow | null,
  requested: EventRow | null,
  rejected: EventRow | null,
  runtime: EventRow | null,
  terminal: EventRow | null,
  ctx: StoreReadContext,
): JobProjectionDetail {
  const launch = decodeLaunch(jobId, requested, ctx);
  const terminalRecord = decodeTerminalRecord(terminal, ctx);
  const diagnostics =
    terminalRecord === null
      ? decodeProjectionDiagnostics(projection)
      : mergeDiagnostics(decodeProjectionDiagnostics(projection), terminalRecord.diagnostics);
  const exit = terminal && terminalRecord ? toJobExitProjection(terminal, terminalRecord, diagnostics) : null;

  const status = projection
    ? projectionRowToStatus(jobId, projection, rejected, runtime, terminal, requested, ctx)
    : null;

  return {
    status,
    launch,
    runtime: runtime ? jobRuntimeBodyFromEvent(runtime, ctx) : null,
    exit,
  };
}

export function loadJobProjectionDetail(
  db: BetterSqlite3.Database,
  jobId: string,
  ctx: StoreReadContext,
): JobProjectionDetail {
  const projection = readProjectionRow(db, jobId);
  const requested = readLatestEvent(db, 'job', jobId, 'job.launch.requested');
  const rejected = readLatestEvent(db, 'job', jobId, 'job.launch.rejected');
  const runtime = readLatestEvent(db, 'job', jobId, 'job.runtime.started');
  const terminal = readLatestEvent(db, 'job', jobId, 'job.terminal.recorded');
  return hydrateJobProjectionDetail(jobId, projection, requested, rejected, runtime, terminal, ctx);
}

export function loadJobProjectionDetails(
  db: BetterSqlite3.Database,
  jobIds: string[],
  ctx: StoreReadContext,
): Map<string, JobProjectionDetail> {
  const uniqueJobIds = [...new Set(jobIds)];
  const details = new Map<string, JobProjectionDetail>(
    uniqueJobIds.map((jobId) => [jobId, emptyJobProjectionDetail()]),
  );

  if (uniqueJobIds.length === 0) {
    return details;
  }

  const projectionsByJob = readProjectionRows(db, uniqueJobIds);
  const requestedByJob = readLatestEventsForJobs(db, uniqueJobIds, 'job.launch.requested');
  const statusEventsByJob = readLatestProjectionStatusEvents(db, uniqueJobIds);

  for (const jobId of uniqueJobIds) {
    const statusEvents = statusEventsByJob.get(jobId) ?? {
      rejected: null,
      runtime: null,
      terminal: null,
    };
    details.set(
      jobId,
      hydrateJobProjectionDetail(
        jobId,
        projectionsByJob.get(jobId) ?? null,
        requestedByJob.get(jobId) ?? null,
        statusEvents.rejected,
        statusEvents.runtime,
        statusEvents.terminal,
        ctx,
      ),
    );
  }

  return details;
}

export function listJobProjections(
  db: BetterSqlite3.Database,
  ctx: StoreReadContext,
  filters?: JobsListFilters,
): Array<{ jobId: string; status: JobStatus }> {
  const projections = readOrderedProjectionRows(db, filters);
  const statusEventsByJob = readLatestProjectionStatusEvents(
    db,
    projections.map(({ job_id: jobId }) => jobId),
  );

  return projections.map((projection) => {
    const statusEvents = statusEventsByJob.get(projection.job_id) ?? {
      rejected: null,
      runtime: null,
      terminal: null,
    };

    return {
      jobId: projection.job_id,
      status: projectionRowToStatus(
        projection.job_id,
        projection,
        statusEvents.rejected,
        statusEvents.runtime,
        statusEvents.terminal,
        null,
        ctx,
      ),
    };
  });
}

export function listJobs(
  db: BetterSqlite3.Database,
  filters: JobsListFilters,
  ctx: StoreReadContext,
): Array<{ jobId: string; status: JobStatus }> {
  return listJobProjections(db, ctx, filters);
}

export function loadJobDetail(
  db: BetterSqlite3.Database,
  jobId: string,
  ctx: StoreReadContext,
  options: { namespace?: string } = {},
): JobDetail | null {
  const detail = loadJobProjectionDetail(db, jobId, ctx);
  const status = detail.status;

  if (status === null) {
    return null;
  }
  if (options.namespace !== undefined && !belongsToNamespace(status, options.namespace)) {
    return null;
  }

  return {
    status,
    events: readJobEvents(db, jobId, ctx),
  };
}

export function readJobEvents(db: BetterSqlite3.Database, jobId: string, ctx: StoreReadContext): JobEvent[] {
  const rows = prepareCached<
    [string],
    {
      seq: number;
      ts: string;
      type: string;
      body_version: number;
      body: Uint8Array | Buffer;
    }
  >(
    db,
    `SELECT
       seq,
       ts,
       type,
       body_version,
       body
     FROM events
     WHERE stream_kind = 'job'
       AND stream_id = ?
       AND type IN ('job.progress.emitted', 'job.terminal.recorded')
     ORDER BY seq ASC`,
  ).all(jobId) as Array<{
    seq: number;
    ts: string;
    type: string;
    body_version: number;
    body: Uint8Array | Buffer;
  }>;

  const sessionId = readProjectionRow(db, jobId)?.session_id ?? null;

  return rows.flatMap<JobProgressProjection>((row) => {
    if (row.type === 'job.progress.emitted') {
      const body = decodeBody(row, jobProgressBodySchema, ctx);
      if (body.kind !== 'message') {
        return [];
      }

      return [
        {
          jobId,
          sessionId,
          seq: row.seq,
          type: 'progress' as const,
          ts: row.ts,
          message: body.message,
        },
      ];
    }

    const terminal = decodeTerminalRecord(
      {
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        body_version: row.body_version,
        body: row.body,
      },
      ctx,
    );

    return [
      {
        jobId,
        sessionId,
        seq: row.seq,
        type: 'terminal' as const,
        ts: row.ts,
        result: terminal?.record ?? { content: '', outcome: { kind: 'completed' }, durationMs: 0 },
        continuity: terminal?.continuity ?? null,
      },
    ];
  });
}
