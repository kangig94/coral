import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { acquireSharedFileLockSync } from '../infra/fs-lock.js';
import type { StoragePort } from '../infra/port-types.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import { STORE_DATABASE_FILE_NAME, STORE_LOCK_FILE_NAME, type ResolvedStoreEpoch } from '../store/epoch.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { JobLocationIndex, type JobLocationSubject } from './location-index.js';
import { describeTerminalOutcome } from './outcome.js';
import { jobKindSchema, type JobDetailResponse, type JobDiagnostics, type JobEvent, type JobStatus } from './records.js';
import { jobPhaseSchema, isTerminalPhase } from './phase.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';
import { writeResultArtifact } from './terminal/export.js';

const FINGERPRINT_0100 = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const FINGERPRINT_0105 = 'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980';
const FINGERPRINT_0110 = 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521';

const olderProjectionSchema = z.object({
  job_id: z.string().min(1),
  execution_owner: z.string(),
  phase: z.string(),
  diagnostics: z.string(),
  session_id: z.string().nullable(),
  provider: z.string().nullable(),
  project_root: z.string().min(1),
  backend_namespace: z.string().min(1),
  bundle_hash: z.string().nullable(),
  job_kind: z.string(),
  parent_workflow_job_id: z.string().nullable(),
  workflow_slot: z.string().nullable(),
  workflow_slot_generation: z.number().nullable(),
  replaces_workflow_job_id: z.string().nullable(),
  created_at: z.string(),
  last_seq: z.number().int().nonnegative(),
}).passthrough();
const newerProjectionSchema = olderProjectionSchema.extend({ work_dir: z.string().nullable() });
const eventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  body: z.instanceof(Uint8Array),
});
const terminalBodySchema = z.object({
  terminal: jobTerminalSchema,
  diagnostics: z.object({}).passthrough().optional(),
}).passthrough();
const progressBodySchema = z.object({
  kind: z.literal('message'),
  message: z.string(),
  timing: jobProgressTimingSchema,
}).passthrough();
const launchBodySchema = z.object({
  projectRoot: z.string().min(1),
  jobKind: jobKindSchema,
  request: z.object({ cwd: z.string().min(1) }).passthrough().optional(),
}).passthrough();

type Projection = z.infer<typeof olderProjectionSchema> & { work_dir?: string | null };
type HistoricalReader = (db: DatabaseSync) => Projection[];
type HistoricalEpochSource = Readonly<{
  epoch: ResolvedStoreEpoch;
  fingerprint: string;
  jobsRoot: string;
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>;
}>;
const historicalSources = new WeakMap<JobLocationIndex, Map<string, HistoricalEpochSource>>();
export type KnownHistoricalJob = Readonly<{ jobId: string; subject: JobLocationSubject }>;
export type HistoricalSeedResult =
  | Readonly<{ kind: 'complete'; jobIds: readonly string[] }>
  | Readonly<{ kind: 'uncertified'; knownJobIds: readonly string[] }>
  | Readonly<{ kind: 'unrecoverable-retained'; knownJobIds: readonly string[]; reason: string }>;

function read0100(db: DatabaseSync): Projection[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all().map((row) => olderProjectionSchema.parse(row));
}

function read0105(db: DatabaseSync): Projection[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all().map((row) => olderProjectionSchema.parse(row));
}

function read0110(db: DatabaseSync): Projection[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all().map((row) => newerProjectionSchema.parse(row));
}

const readers: Readonly<Record<string, HistoricalReader>> = {
  [FINGERPRINT_0100]: read0100,
  [FINGERPRINT_0105]: read0105,
  [FINGERPRINT_0110]: read0110,
};

function readEvents(db: DatabaseSync, jobId: string): z.infer<typeof eventSchema>[] {
  return db.prepare(
    `SELECT seq, ts, type, body FROM events
      WHERE stream_kind = 'job' AND stream_id = ?
        AND type IN ('job.launch.requested', 'job.progress.emitted', 'job.runtime.started', 'job.terminal.recorded')
      ORDER BY seq ASC`,
  ).all(jobId).map((row) => eventSchema.parse(row));
}

function parseBody(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

function diagnosticsFrom(raw: string): JobDiagnostics {
  return jobDiagnosticsSchema.parse(JSON.parse(raw) as unknown);
}

function historicalDetail(row: Projection, events: readonly z.infer<typeof eventSchema>[]): JobDetailResponse {
  const launch = events.find((event) => event.type === 'job.launch.requested');
  const launchBody = launch === undefined ? null : z.object({ request: z.object({ cwd: z.string() }).passthrough() })
    .passthrough().safeParse(parseBody(launch.body));
  const jobKind = jobKindSchema.parse(row.job_kind);
  const workDir = jobKind === 'kb'
    ? null
    : canonicalWorkDirWireSchema.parse(
        row.work_dir ?? (launchBody?.success ? launchBody.data.request.cwd : row.project_root),
      );
  const phase = jobPhaseSchema.parse(row.phase);
  const terminalEvent = [...events].reverse().find((event) => event.type === 'job.terminal.recorded');
  const terminalBody = terminalEvent === undefined ? null : terminalBodySchema.parse(parseBody(terminalEvent.body));
  const status: JobStatus = {
    jobId: row.job_id,
    owner: executionOwnerSchema.parse(JSON.parse(row.execution_owner) as unknown),
    sessionId: row.session_id,
    provider: row.provider,
    projectRoot: row.project_root,
    workDir,
    backendNamespace: row.backend_namespace,
    ...(row.bundle_hash === null ? {} : { bundleHash: row.bundle_hash }),
    jobKind,
    ...(row.parent_workflow_job_id === null ? {} : { parentWorkflowJobId: row.parent_workflow_job_id }),
    ...(row.workflow_slot === null ? {} : { workflowSlotId: row.workflow_slot }),
    ...(row.workflow_slot_generation === null ? {} : { workflowSlotGeneration: row.workflow_slot_generation }),
    ...(row.replaces_workflow_job_id === null ? {} : { replacesWorkflowJobId: row.replaces_workflow_job_id }),
    phase,
    updatedAt: events.at(-1)?.ts ?? row.created_at,
    lastSeq: row.last_seq,
    ...(terminalBody === null ? {} : { result: terminalBody.terminal }),
  };
  const diagnostics = diagnosticsFrom(row.diagnostics);
  const renderedEvents: JobEvent[] = [];
  for (const event of events) {
    if (event.type === 'job.progress.emitted') {
      const progress = progressBodySchema.safeParse(parseBody(event.body));
      if (!progress.success) continue;
      renderedEvents.push({
        type: 'progress', jobId: row.job_id, sessionId: row.session_id,
        seq: event.seq, ts: event.ts, message: progress.data.message, timing: progress.data.timing,
      });
    } else if (event.type === 'job.terminal.recorded' && terminalBody !== null) {
      renderedEvents.push({
        type: 'terminal', jobId: row.job_id, sessionId: row.session_id,
        seq: event.seq, ts: event.ts, result: terminalBody.terminal,
        ...(diagnostics.usage === undefined ? {} : { usage: diagnostics.usage }),
      });
    }
  }
  const runtimeStarted = events.some((event) => event.type === 'job.runtime.started');
  return {
    status,
    events: renderedEvents,
    readiness: phase === 'queued' ? 'queued' : phase === 'launching' ? 'pending'
      : (phase === 'error' || phase === 'aborted') && !runtimeStarted ? 'error' : 'ready',
    exit: terminalEvent === undefined || terminalBody === null ? null : {
      ...terminalBody.terminal,
      diagnostics,
      endTime: terminalEvent.ts,
    },
  };
}

export function seedHistoricalEpoch(
  index: JobLocationIndex,
  epoch: ResolvedStoreEpoch,
  epochKey: string,
  fingerprint: string,
  jobsRoot: string,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  knownJobs: readonly KnownHistoricalJob[] = [],
  certifyRetiredEpoch = false,
): HistoricalSeedResult {
  const sources = historicalSources.get(index) ?? new Map<string, HistoricalEpochSource>();
  sources.set(epochKey, { epoch, fingerprint, jobsRoot, storage });
  historicalSources.set(index, sources);
  for (const known of knownJobs) {
    index.register(known.jobId, epochKey, known.subject);
  }
  const reader = readers[fingerprint];
  const dbPath = join(epoch.path, STORE_DATABASE_FILE_NAME);
  if (reader === undefined || !existsSync(dbPath)) {
    index.holdUnknownLocations(epochKey, reader === undefined ? 'unsupported-store-fingerprint' : 'retained-store-root-missing');
    for (const location of index.locationsFor(epochKey)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: reader === undefined ? 'unsupported-store-fingerprint' : 'retained-store-root-missing',
    };
  }
  let releaseLock: (() => void) | null = null;
  let db: DatabaseSync | null = null;
  try {
    releaseLock = acquireSharedFileLockSync(join(epoch.path, STORE_LOCK_FILE_NAME));
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = reader(db);
    const highWaterSeq = (db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'",
    ).get() as { seq: number }).seq;
    const observed = new Set<string>();
    const launches = db.prepare(
      "SELECT stream_id, body FROM events WHERE stream_kind = 'job' AND type = 'job.launch.requested' ORDER BY seq ASC",
    ).all() as Array<{ stream_id: string; body: Uint8Array }>;
    for (const launch of launches) {
      const body = launchBodySchema.parse(parseBody(launch.body));
      index.register(launch.stream_id, epochKey, {
        projectRoot: body.projectRoot,
        workDir: body.jobKind === 'kb' ? null : body.request?.cwd ?? body.projectRoot,
        jobKind: body.jobKind,
      });
    }
    for (const row of rows) {
      observed.add(row.job_id);
      const events = readEvents(db, row.job_id);
      const detail = historicalDetail(row, events);
      index.register(row.job_id, epochKey, {
        projectRoot: detail.status.projectRoot,
        workDir: detail.status.workDir,
        jobKind: detail.status.jobKind,
      });
      if (!isTerminalPhase(detail.status.phase) || detail.exit === null) {
        index.recordObserved(row.job_id, detail);
        index.markUnresolved(row.job_id);
        continue;
      }
      const terminal = [...detail.events].reverse().find((event) => event.type === 'terminal');
      if (terminal === undefined) {
        index.markUnresolved(row.job_id);
        continue;
      }
      const content = detail.exit.content.trimEnd();
      const markdown = content.length > 0
        ? `${content}\n`
        : `${describeTerminalOutcome(detail.exit.outcome)}\n`;
      const resultPath = writeResultArtifact(storage, jobsRoot, row.job_id, markdown);
      index.recordTerminal(row.job_id, detail, resultPath, terminal.seq);
    }
    for (const launch of launches) {
      if (!observed.has(launch.stream_id)) {
        observed.add(launch.stream_id);
        index.markUnresolved(launch.stream_id);
      }
    }
    for (const known of knownJobs) {
      if (!observed.has(known.jobId)) {
        observed.add(known.jobId);
        index.markUnresolved(known.jobId);
      }
    }
    index.clearUnknownLocations(epochKey);
    if (!certifyRetiredEpoch) return { kind: 'uncertified', knownJobIds: [...observed] };
    const certificate = index.certify(epochKey, highWaterSeq);
    return certificate === null
      ? { kind: 'unrecoverable-retained', knownJobIds: [...observed], reason: 'known-jobs-unresolved' }
      : { kind: 'complete', jobIds: certificate.jobIds };
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error));
    for (const location of index.locationsFor(epochKey)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
    releaseLock?.();
  }
}

export function refreshHistoricalEpoch(index: JobLocationIndex, epochKey: string, jobIds: readonly string[]): void {
  const source = historicalSources.get(index)?.get(epochKey);
  if (source === undefined) return;
  const reader = readers[source.fingerprint];
  const dbPath = join(source.epoch.path, STORE_DATABASE_FILE_NAME);
  if (reader === undefined || !existsSync(dbPath)) return;

  let releaseLock: (() => void) | null = null;
  let db: DatabaseSync | null = null;
  try {
    releaseLock = acquireSharedFileLockSync(join(source.epoch.path, STORE_LOCK_FILE_NAME));
    db = new DatabaseSync(dbPath, { readOnly: true });
    const requested = new Set(jobIds);
    for (const row of reader(db)) {
      if (!requested.has(row.job_id)) continue;
      const location = index.read(row.job_id);
      if (location === null || location.epochKey !== epochKey || location.disposition === 'terminal') continue;
      const detail = historicalDetail(row, readEvents(db, row.job_id));
      const terminal = [...detail.events].reverse().find((event) => event.type === 'terminal');
      if (!isTerminalPhase(detail.status.phase) || detail.exit === null || terminal === undefined) {
        index.recordObserved(row.job_id, detail);
        continue;
      }
      const content = detail.exit.content.trimEnd();
      const markdown = content.length > 0
        ? `${content}\n`
        : `${describeTerminalOutcome(detail.exit.outcome)}\n`;
      const resultPath = writeResultArtifact(source.storage, source.jobsRoot, row.job_id, markdown);
      index.recordTerminal(row.job_id, detail, resultPath, terminal.seq);
    }
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
    releaseLock?.();
  }
}
