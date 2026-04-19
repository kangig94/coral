import type BetterSqlite3 from 'better-sqlite3';

import { jobProgressBodySchema, jobRuntimeStartedBodySchema, jobTerminalRecordedBodySchema } from '../../jobs/events.js';
import { jobLaunchRequestBodySchema } from '../../jobs/launch.js';
import { describeLaunchRejected, jobLaunchRejectedSchema } from '../../jobs/outcome.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { JobStatusRecord, JobTerminalRecord } from '../../jobs/records.js';

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
  perJobIndex: number;
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

type EventRow = {
  seq: number;
  ts: string;
  body: Uint8Array | Buffer;
};

function decodeJson<T>(row: { body: Uint8Array | Buffer }): T {
  return JSON.parse(Buffer.from(row.body).toString('utf-8')) as T;
}

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

function readLatestEvent(
  db: BetterSqlite3.Database,
  jobId: string,
  type: string,
): EventRow | null {
  const row = db
    .prepare(
      `SELECT seq, ts, body
         FROM events
        WHERE stream_kind = 'job' AND stream_id = ? AND type = ?
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId, type) as EventRow | undefined;

  return row ?? null;
}

function deriveLaunchState(
  phase: JobPhase,
  rejected: ReturnType<typeof readLatestEvent>,
  runtime: ReturnType<typeof readLatestEvent>,
  terminal: ReturnType<typeof readLatestEvent>,
): { state: JobStatusRecord['launch']['state']; message?: string } {
  if (rejected) {
    const body = jobLaunchRejectedSchema.parse(decodeJson(rejected));
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

function decodeLaunch(jobId: string, row: EventRow | null): JobLaunchRow | null {
  if (!row) {
    return null;
  }

  const body = jobLaunchRequestBodySchema.parse(decodeJson(row));
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

function decodeRuntime(row: EventRow | null): JobRuntimeRow {
  if (!row) {
    return null;
  }

  return jobRuntimeBodyFromEvent(row);
}

function jobRuntimeBodyFromEvent(row: EventRow): JobRuntimeRow {
  const parsed = jobRuntimeStartedBodySchema.parse(JSON.parse(Buffer.from(row.body).toString('utf-8')) as unknown);
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

function decodeExit(row: EventRow | null): JobExitRow | null {
  if (!row) {
    return null;
  }

  const body = jobTerminalRecordedBodySchema.parse(decodeJson(row));
  return {
    outcome: body.outcome,
    content: body.content ?? '',
    durationMs: body.durationMs,
    exitCode: body.exitCode,
    signal: body.signal,
    endTime: row.ts,
    nonResumable: body.nonResumable,
    warnings: body.warnings,
    usage: body.usage,
    workflow: body.workflow,
  };
}

function decodeTerminalRecord(row: EventRow | null): JobTerminalRecord | null {
  if (!row) {
    return null;
  }

  const body = jobTerminalRecordedBodySchema.parse(decodeJson(row));
  return {
    content: body.content ?? '',
    durationMs: body.durationMs,
    exitCode: body.exitCode,
    nonResumable: body.nonResumable,
    warnings: body.warnings,
    usage: body.usage,
    workflow: body.workflow,
    outcome: body.outcome,
  };
}

export function loadJobProjectionDetail(
  db: BetterSqlite3.Database,
  jobId: string,
): JobProjectionDetail {
  const projection = readProjectionRow(db, jobId);
  const requested = readLatestEvent(db, jobId, 'job.launch.requested');
  const rejected = readLatestEvent(db, jobId, 'job.launch.rejected');
  const runtime = readLatestEvent(db, jobId, 'job.runtime.started');
  const terminal = readLatestEvent(db, jobId, 'job.terminal.recorded');
  const launch = decodeLaunch(jobId, requested);
  const exit = decodeExit(terminal);

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
            ...deriveLaunchState(projection.phase as JobPhase, rejected, runtime, terminal),
            updatedAt: terminal?.ts ?? runtime?.ts ?? requested?.ts ?? new Date(0).toISOString(),
          },
          ...(terminal ? { result: decodeTerminalRecord(terminal) ?? undefined } : {}),
        }
      : null;

  return {
    status,
    launch,
    runtime: decodeRuntime(runtime),
    exit,
  };
}

export function listJobProjections(
  db: BetterSqlite3.Database,
): Array<{ jobId: string; status: JobStatusRecord }> {
  const rows = db
    .prepare(
      `SELECT job_id
         FROM projection_jobs
        ORDER BY job_id ASC`,
    )
    .all() as Array<{ job_id: string }>;

  return rows.flatMap(({ job_id: jobId }) => {
    const detail = loadJobProjectionDetail(db, jobId);
    return detail.status ? [{ jobId, status: detail.status }] : [];
  });
}

export function readJobProgress(
  db: BetterSqlite3.Database,
  jobId: string,
): JobProgressRow[] {
  const rows = db
    .prepare(
      `SELECT
         seq,
         ts,
         type,
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
      per_job_index: number;
      body: Uint8Array | Buffer;
    }>;

  const detail = loadJobProjectionDetail(db, jobId);
  const sessionId = detail.launch?.sessionId ?? detail.status?.sessionId ?? '';

  return rows.flatMap<JobProgressRow>((row) => {
    if (row.type === 'job.progress.emitted') {
      const body = jobProgressBodySchema.parse(JSON.parse(Buffer.from(row.body).toString('utf-8')) as unknown);
      if (body.kind !== 'message') {
        return [];
      }

      return [{
        jobId,
        sessionId,
        seq: row.seq,
        perJobIndex: row.per_job_index,
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
      perJobIndex: row.per_job_index,
      eventId: row.per_job_index,
      type: 'terminal' as const,
        ts: row.ts,
        result: decodeTerminalRecord({
          seq: row.seq,
          ts: row.ts,
          body: row.body,
      }) ?? { content: '', outcome: { kind: 'completed' } },
    }];
  });
}
