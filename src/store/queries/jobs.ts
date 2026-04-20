import type BetterSqlite3 from 'better-sqlite3';

import { jobProgressBodySchema, jobRuntimeStartedBodySchema, jobTerminalRecordedBodySchema } from '../../jobs/events.js';
import { jobLaunchRequestBodySchema } from '../../jobs/launch.js';
import { describeLaunchRejected, jobLaunchRejectedSchema } from '../../jobs/outcome.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { JobProjectionDetail } from '../../jobs/read-contracts.js';
import type { JobProgress, JobStatus, JobTerminal } from '../../jobs/views.js';
import { decodeBody, type StoreReadContext } from '../body-codec.js';
import { readLatestEvent } from './events.js';
import type { EventsRow } from '../schema.js';

type JobLaunchProjection = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: 'provider' | 'workflow';
  pool: string;
  enqueueSequence: number;
  providerAction: 'exec' | 'resume' | 'fork';
  request: {
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
  };
  parentWorkflowJobId?: string;
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
    recoveryPolicy: 'session_continuity_only';
  };
};

type JobRuntimeProjection = JobCliRuntimeProjection | JobAppServerRuntimeProjection | null;

type JobExitProjection = {
  outcome: JobTerminal['outcome'];
  content: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  endTime: string;
  nonResumable?: boolean;
  warnings?: string[];
  usage?: JobTerminal['usage'];
  workflow?: JobTerminal['workflow'];
};

type JobProgressProjection = {
  jobId: string;
  sessionId: string;
  seq: number;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminal;
};

type ProjectionRow = {
  job_id: string;
  phase: string;
  terminal: string | null;
  diagnostics: string | null;
  session_id: string;
  provider: string;
  project_root: string;
  backend_namespace: string;
  bundle_hash: string | null;
  job_kind: 'provider' | 'workflow';
  parent_workflow_job_id: string | null;
  workflow_slot: string | null;
  created_at: string;
  last_seq: number;
};

type EventRow = Pick<EventsRow, 'seq' | 'ts' | 'type' | 'body_version' | 'body'>;
type LatestJobEventProjection = EventRow & { stream_id: string };
type ProjectionStatusEventType = 'job.launch.rejected' | 'job.runtime.started' | 'job.terminal.recorded';
type JobStatusEventsByType = {
  rejected: EventRow | null;
  runtime: EventRow | null;
  terminal: EventRow | null;
};
type DecodedTerminalRow = {
  record: JobTerminal;
  signal?: string | null;
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

function readProjectionRow(
  db: BetterSqlite3.Database,
  jobId: string,
): ProjectionRow | null {
  const row = db
    .prepare(
      `SELECT job_id, phase, terminal, diagnostics,
              session_id, provider, project_root, backend_namespace, bundle_hash,
              job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as ProjectionRow | undefined;

  return row ?? null;
}

function readProjectionRows(
  db: BetterSqlite3.Database,
  jobIds: string[],
): Map<string, ProjectionRow> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const rows = db
    .prepare(
      `SELECT job_id, phase, terminal, diagnostics,
              session_id, provider, project_root, backend_namespace, bundle_hash,
              job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
         FROM projection_jobs
        WHERE job_id IN (${sqlPlaceholders(jobIds.length)})`,
    )
    .all(...jobIds) as ProjectionRow[];

  return new Map(rows.map((row) => [row.job_id, row]));
}

function readOrderedProjectionRows(db: BetterSqlite3.Database): ProjectionRow[] {
  return db
    .prepare(
      `SELECT job_id, phase, terminal, diagnostics,
              session_id, provider, project_root, backend_namespace, bundle_hash,
              job_kind, parent_workflow_job_id, workflow_slot, created_at, last_seq
         FROM projection_jobs
        ORDER BY job_id ASC`,
    )
    .all() as ProjectionRow[];
}

function readLatestEventsForJobs(
  db: BetterSqlite3.Database,
  jobIds: string[],
  type: string,
): Map<string, EventRow> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const rows = db
    .prepare(
      `SELECT stream_id, seq, ts, type, body_version, body
         FROM events
        WHERE stream_kind = 'job'
          AND type = ?
          AND stream_id IN (${sqlPlaceholders(jobIds.length)})
        ORDER BY stream_id ASC, seq DESC`,
    )
    .all(type, ...jobIds) as LatestJobEventProjection[];

  const eventsByJob = new Map<string, EventRow>();
  for (const row of rows) {
    if (eventsByJob.has(row.stream_id)) {
      continue;
    }

    eventsByJob.set(row.stream_id, {
      seq: row.seq,
      ts: row.ts,
      type: row.type,
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

  const rows = db
    .prepare(
      `SELECT stream_id, type, seq, ts, body_version, body
         FROM (
           SELECT stream_id, type, seq, ts, body_version, body,
                  ROW_NUMBER() OVER (PARTITION BY stream_id, type ORDER BY seq DESC) AS row_number
             FROM events
            WHERE stream_kind = 'job'
              AND type IN ('job.launch.rejected', 'job.runtime.started', 'job.terminal.recorded')
              AND stream_id IN (${sqlPlaceholders(jobIds.length)})
         )
        WHERE row_number = 1`,
    )
    .all(...jobIds) as Array<LatestJobEventProjection & { type: ProjectionStatusEventType }>;

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

function deriveLaunchState(
  phase: JobPhase,
  rejected: EventRow | null,
  runtime: EventRow | null,
  terminal: EventRow | null,
  ctx: StoreReadContext,
): { state: JobStatus['launch']['state']; message?: string } {
  if (rejected) {
    const body = decodeBody(rejected, jobLaunchRejectedSchema, ctx);
    return {
      state: 'error',
      message: describeLaunchRejected(body),
    };
  }

  if (phase === 'queued') {
    return { state: 'queued' };
  }

  if (phase === 'launching') {
    return { state: 'pending' };
  }

  if ((phase === 'error' || phase === 'aborted') && !runtime && terminal) {
    return { state: 'error' };
  }

  return { state: 'ready' };
}

function decodeLaunch(jobId: string, row: EventRow | null, ctx: StoreReadContext): JobLaunchProjection | null {
  if (!row) {
    return null;
  }

  const body = decodeBody(row, jobLaunchRequestBodySchema, ctx);
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
    parentWorkflowJobId: body.parentJobId,
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
        serverGeneration: typeof providerMeta?.serverGeneration === 'number' ? providerMeta.serverGeneration : undefined,
        providerContinuity:
          providerMeta?.providerContinuity && typeof providerMeta.providerContinuity === 'object'
          ? (providerMeta.providerContinuity as Record<string, unknown>)
          : undefined,
        recoveryPolicy: 'session_continuity_only',
      },
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

function decodeTerminalRecord(row: EventRow | null, ctx: StoreReadContext): DecodedTerminalRow | null {
  if (!row) {
    return null;
  }

  const body = decodeBody(row, jobTerminalRecordedBodySchema, ctx);
  return {
    record: {
      content: body.content ?? '',
      durationMs: body.durationMs,
      outcome: body.outcome,
      ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }),
      ...(body.nonResumable === undefined ? {} : { nonResumable: body.nonResumable }),
      ...(body.warnings === undefined ? {} : { warnings: body.warnings }),
      ...(body.usage === undefined ? {} : { usage: body.usage }),
      ...(body.workflow === undefined ? {} : { workflow: body.workflow }),
    },
    ...(body.signal === undefined ? {} : { signal: body.signal }),
  };
}

function toJobExitProjection(row: EventRow, terminal: DecodedTerminalRow): JobExitProjection {
  return {
    ...terminal.record,
    signal: terminal.signal,
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
    launch: {
      ...deriveLaunchState(projection.phase as JobPhase, rejected, runtime, terminal, ctx),
      updatedAt: terminal?.ts ?? runtime?.ts ?? rejected?.ts ?? requested?.ts ?? projection.created_at,
    },
    ...(terminalRecord ? { result: terminalRecord.record } : {}),
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
  const exit = terminal && terminalRecord ? toJobExitProjection(terminal, terminalRecord) : null;

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
): Array<{ jobId: string; status: JobStatus }> {
  const projections = readOrderedProjectionRows(db);
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

export function readJobProgress(
  db: BetterSqlite3.Database,
  jobId: string,
  ctx: StoreReadContext,
): JobProgress[] {
  const rows = db
    .prepare(
      `SELECT
         seq,
         ts,
         type,
         body_version,
         ROW_NUMBER() OVER (ORDER BY seq) AS per_job_index,
         body
       FROM events
       WHERE stream_kind = 'job'
         AND stream_id = ?
         AND type IN ('job.progress.emitted', 'job.terminal.recorded')
       ORDER BY seq ASC`,
    )
    .all(jobId) as Array<{
      seq: number;
      ts: string;
      type: string;
      body_version: number;
      per_job_index: number;
      body: Uint8Array | Buffer;
    }>;

  const sessionId = readProjectionRow(db, jobId)?.session_id ?? '';

  return rows.flatMap<JobProgressProjection>((row) => {
    if (row.type === 'job.progress.emitted') {
      const body = decodeBody(row, jobProgressBodySchema, ctx);
      if (body.kind !== 'message') {
        return [];
      }

      return [{
        jobId,
        sessionId,
        seq: row.seq,
        eventId: row.per_job_index,
        type: 'progress' as const,
        ts: row.ts,
        message: body.message,
      }];
    }

    return [{
      jobId,
      sessionId,
      seq: row.seq,
      eventId: row.per_job_index,
      type: 'terminal' as const,
      ts: row.ts,
      result: decodeTerminalRecord({
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        body_version: row.body_version,
        body: row.body,
      }, ctx)?.record ?? { content: '', outcome: { kind: 'completed' } },
    }];
  });
}
