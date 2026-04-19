import type BetterSqlite3 from 'better-sqlite3';

import { jobProgressBodySchema, jobRuntimeStartedBodySchema, jobTerminalRecordedBodySchema } from '../../jobs/events.js';
import { jobLaunchRequestBodySchema } from '../../jobs/launch.js';
import { describeLaunchRejected, jobLaunchRejectedSchema } from '../../jobs/outcome.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { JobStatusRecord, JobTerminalRecord } from '../../jobs/records.js';
import { decodeBody, decodeEventBody, type StoreReadContext } from '../body-codec.js';
import { readLatestEvent } from './events.js';
import type { EventsRow } from '../schema.js';

export type JobLaunchRow = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: 'provider' | 'workflow';
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

export type JobCliRuntimeRow = {
  transport?: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  providerMeta?: Record<string, unknown>;
  tailWatermark?: number;
};

export type JobAppServerRuntimeRow = {
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

export type JobRuntimeRow = JobCliRuntimeRow | JobAppServerRuntimeRow | null;

export type JobExitRow = {
  outcome: JobTerminalRecord['outcome'];
  content: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  endTime: string;
  nonResumable?: boolean;
  warnings?: string[];
  usage?: JobTerminalRecord['usage'];
  workflow?: JobTerminalRecord['workflow'];
};

export type JobProgressRow = {
  jobId: string;
  sessionId: string;
  seq: number;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminalRecord;
};

export type JobProjectionDetail = {
  status: JobStatusRecord | null;
  launch: JobLaunchRow | null;
  runtime: JobRuntimeRow;
  exit: JobExitRow | null;
};

type ProjectionRow = {
  job_id: string;
  phase: string;
  terminal: string | null;
  last_seq: number;
};

type EventRow = Pick<EventsRow, 'seq' | 'ts' | 'type' | 'body_version' | 'body'>;
type DecodedTerminalRow = {
  record: JobTerminalRecord;
  signal?: string | null;
};

function readProjectionRow(
  db: BetterSqlite3.Database,
  jobId: string,
): ProjectionRow | null {
  const row = db
    .prepare(
      `SELECT job_id, phase, terminal, last_seq
         FROM projection_jobs
        WHERE job_id = ?`,
    )
    .get(jobId) as ProjectionRow | undefined;

  return row ?? null;
}

function deriveLaunchState(
  phase: JobPhase,
  rejected: ReturnType<typeof readLatestEvent>,
  runtime: ReturnType<typeof readLatestEvent>,
  terminal: ReturnType<typeof readLatestEvent>,
  ctx: StoreReadContext,
): { state: JobStatusRecord['launch']['state']; message?: string } {
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

function decodeLaunch(jobId: string, row: EventRow | null, ctx: StoreReadContext): JobLaunchRow | null {
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

function jobRuntimeBodyFromEvent(row: EventRow, ctx: StoreReadContext): JobRuntimeRow {
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
      exitCode: body.exitCode,
      nonResumable: body.nonResumable,
      warnings: body.warnings,
      usage: body.usage,
      workflow: body.workflow,
      outcome: body.outcome,
    },
    signal: body.signal,
  };
}

function toJobExitRow(row: EventRow, terminal: DecodedTerminalRow): JobExitRow {
  return {
    ...terminal.record,
    signal: terminal.signal,
    endTime: row.ts,
  };
}

// TODO(rewrite): Replace this replay helper with projection_jobs.session_id once that column exists.
function readLaunchSessionId(
  db: BetterSqlite3.Database,
  jobId: string,
  ctx: StoreReadContext,
): string {
  const row = db
    .prepare(
      `SELECT type, body_version, body
         FROM events
        WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'
        ORDER BY seq ASC
        LIMIT 1`,
    )
    .get(jobId) as Pick<EventsRow, 'type' | 'body_version' | 'body'> | undefined;

  if (!row) {
    return '';
  }

  return decodeBody(row, jobLaunchRequestBodySchema, ctx).sessionId;
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
  const launch = decodeLaunch(jobId, requested, ctx);
  const terminalRecord = decodeTerminalRecord(terminal, ctx);
  const exit = terminal && terminalRecord ? toJobExitRow(terminal, terminalRecord) : null;

  const status =
    projection && launch
      ? {
          jobId,
          sessionId: launch.sessionId,
          provider: launch.provider,
          projectRoot: launch.projectRoot,
          backendNamespace: launch.backendNamespace,
          bundleHash: launch.bundleHash,
          jobKind: launch.jobKind,
          phase: projection.phase as JobPhase,
          launch: {
            ...deriveLaunchState(projection.phase as JobPhase, rejected, runtime, terminal, ctx),
            updatedAt: terminal?.ts ?? runtime?.ts ?? requested?.ts ?? new Date(0).toISOString(),
          },
          ...(terminalRecord ? { result: terminalRecord.record } : {}),
        }
      : null;

  return {
    status,
    launch,
    runtime: runtime ? jobRuntimeBodyFromEvent(runtime, ctx) : null,
    exit,
  };
}

export function listJobProjections(
  db: BetterSqlite3.Database,
  ctx: StoreReadContext,
): Array<{ jobId: string; status: JobStatusRecord }> {
  const rows = db
    .prepare(
      `SELECT job_id
         FROM projection_jobs
        ORDER BY job_id ASC`,
    )
    .all() as Array<{ job_id: string }>;

  return rows.flatMap(({ job_id: jobId }) => {
    const detail = loadJobProjectionDetail(db, jobId, ctx);
    return detail.status ? [{ jobId, status: detail.status }] : [];
  });
}

export function readJobProgress(
  db: BetterSqlite3.Database,
  jobId: string,
  ctx: StoreReadContext,
): JobProgressRow[] {
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

  const sessionId = readLaunchSessionId(db, jobId, ctx);

  return rows.flatMap<JobProgressRow>((row) => {
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
