import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireSharedFileLockNoRepairSync, acquireSharedFileLockSync } from '../infra/fs-lock.js';
import type { SqliteDatabasePort, StoragePort } from '../infra/port-types.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import type { Runtime } from '../runtime/ports.js';
import { decodeResolvedStoreEpoch, STORE_LOCK_FILE_NAME, type ResolvedStoreEpoch } from '../store/epoch/index.js';
import {
  observeProtectedEpoch,
  observeResolvedStoreEpoch,
  inspectResolvedStoreEpochKey,
} from '../store/epoch/index.js';
import { inspectEpochKey } from '../store/epoch/key.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import {
  hasReadableTerminalDetail,
  type JobLocationIndex,
  type JobLocationSubject,
  type JobLocationView,
  type JobLocation,
} from './location-index.js';
import { phaseForOutcome } from './outcome.js';
import { aggregateWorkflowUsage } from './workflow-usage.js';
import type { Database } from '../store/db.js';
import {
  jobKindSchema,
  type JobDetailResponse,
  type JobDiagnostics,
  type JobEvent,
  type JobStatus,
} from './records.js';
import { jobPhaseSchema, isTerminalPhase } from './phase.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';
import { resultPathFor } from './terminal/export.js';

const FINGERPRINT_0100 = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const FINGERPRINT_0105 = 'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980';
const FINGERPRINT_0110 = 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521';

const olderProjectionSchema = z
  .object({
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
  })
  .passthrough();
const newerProjectionSchema = olderProjectionSchema.extend({ work_dir: z.string().nullable() });
const eventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  body: z.instanceof(Uint8Array),
});
const terminalBodySchema = z
  .object({
    terminal: jobTerminalSchema,
    diagnostics: z.object({}).passthrough().optional(),
  })
  .passthrough();
const progressBodySchema = z
  .object({
    kind: z.literal('message'),
    message: z.string(),
    timing: jobProgressTimingSchema,
  })
  .passthrough();
const launchBodySchema = z.discriminatedUnion('jobKind', [
  z
    .object({
      projectRoot: z.string().min(1),
      jobKind: z.literal('kb'),
      request: z.object({}).passthrough().optional(),
    })
    .passthrough(),
  z
    .object({
      projectRoot: z.string().min(1),
      jobKind: z.enum(['provider', 'workflow']),
      request: z
        .object({ cwd: z.string().min(1) })
        .passthrough()
        .optional(),
    })
    .passthrough(),
]);

type Projection = z.infer<typeof olderProjectionSchema> & { work_dir?: string | null };
type HistoricalReader = (db: SqliteDatabasePort) => Projection[];
type HistoricalEpochSource = {
  readonly runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>;
  readonly originalEpoch: ResolvedStoreEpoch;
  readonly fingerprint: string;
  readonly jobsRoot: string;
  readonly storage: StoragePort;
};
const historicalSources = new WeakMap<JobLocationView, Map<string, HistoricalEpochSource>>();
export function retryUnknownHistoricalEpochs(index: JobLocationIndex): void {
  for (const [epochKey, source] of historicalSources.get(index) ?? []) {
    try {
      if (!index.unknownLocationHolds().some((hold) => hold.epochKey === epochKey && hold.retryScheduled)) continue;
      void seedHistoricalEpoch(
        source.runtime,
        index,
        source.originalEpoch,
        epochKey,
        source.fingerprint,
        source.jobsRoot,
        source.storage,
      );
    } catch {
      // One held epoch must not prevent retrying others.
    }
  }
}
export type KnownHistoricalJob = Readonly<{ jobId: string; subject: JobLocationSubject }>;
export type HistoricalSeedResult =
  | Readonly<{ kind: 'complete'; jobIds: readonly string[] }>
  | Readonly<{ kind: 'uncertified'; knownJobIds: readonly string[] }>
  | Readonly<{ kind: 'unrecoverable-retained'; knownJobIds: readonly string[]; reason: string }>;

function read0100(db: SqliteDatabasePort): Projection[] {
  return db
    .prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC')
    .all()
    .map((row) => olderProjectionSchema.parse(row));
}

function read0105(db: SqliteDatabasePort): Projection[] {
  return db
    .prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC')
    .all()
    .map((row) => olderProjectionSchema.parse(row));
}

function read0110(db: SqliteDatabasePort): Projection[] {
  return db
    .prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC')
    .all()
    .map((row) => newerProjectionSchema.parse(row));
}

const readers: Readonly<Record<string, HistoricalReader>> = {
  [FINGERPRINT_0100]: read0100,
  [FINGERPRINT_0105]: read0105,
  [FINGERPRINT_0110]: read0110,
};

function readEvents(db: SqliteDatabasePort, jobId: string): z.infer<typeof eventSchema>[] {
  return db
    .prepare(
      `SELECT seq, ts, type, body FROM events
      WHERE stream_kind = 'job' AND stream_id = ?
        AND type IN ('job.launch.requested', 'job.progress.emitted', 'job.runtime.started', 'job.terminal.recorded')
      ORDER BY seq ASC`,
    )
    .all(jobId)
    .map((row) => eventSchema.parse(row));
}

function parseBody(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

function diagnosticsFrom(raw: string): JobDiagnostics {
  return jobDiagnosticsSchema.parse(JSON.parse(raw) as unknown);
}

function historicalDetail(
  db: SqliteDatabasePort,
  row: Projection,
  events: readonly z.infer<typeof eventSchema>[],
): JobDetailResponse {
  const launch = events.find((event) => event.type === 'job.launch.requested');
  const launchBody =
    launch === undefined
      ? null
      : z
          .object({ request: z.object({ cwd: z.string() }).passthrough() })
          .passthrough()
          .safeParse(parseBody(launch.body));
  const jobKind = jobKindSchema.parse(row.job_kind);
  const workDir =
    jobKind === 'kb'
      ? null
      : canonicalWorkDirWireSchema.parse(
          row.work_dir ?? (launchBody?.success ? launchBody.data.request.cwd : row.project_root),
        );

  const terminalEvent = [...events].reverse().find((event) => event.type === 'job.terminal.recorded');
  const terminalBody = terminalEvent === undefined ? null : terminalBodySchema.parse(parseBody(terminalEvent.body));
  const phase =
    terminalBody === null ? jobPhaseSchema.parse(row.phase) : phaseForOutcome(terminalBody.terminal.outcome);
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
    lastSeq: terminalEvent?.seq ?? row.last_seq,
    ...(terminalBody === null ? {} : { result: terminalBody.terminal }),
  };
  const diagnostics: JobDiagnostics =
    terminalBody === null
      ? diagnosticsFrom(row.diagnostics)
      : {
          progressFaults: [],
          ...jobDiagnosticsSchema.omit({ progressFaults: true }).parse(terminalBody.diagnostics ?? {}),
        };
  if (jobKind === 'workflow') {
    const usage = aggregateWorkflowUsage(db as Database, row.job_id);
    if (usage !== undefined) diagnostics.usage = usage;
  }
  const renderedEvents: JobEvent[] = [];
  for (const event of events) {
    if (event.type === 'job.progress.emitted') {
      const progress = progressBodySchema.safeParse(parseBody(event.body));
      if (!progress.success) continue;
      renderedEvents.push({
        type: 'progress',
        jobId: row.job_id,
        sessionId: row.session_id,
        seq: event.seq,
        ts: event.ts,
        message: progress.data.message,
        timing: progress.data.timing,
      });
    } else if (event.type === 'job.terminal.recorded' && terminalBody !== null) {
      renderedEvents.push({
        type: 'terminal',
        jobId: row.job_id,
        sessionId: row.session_id,
        seq: event.seq,
        ts: event.ts,
        result: terminalBody.terminal,
        ...(diagnostics.usage === undefined ? {} : { usage: diagnostics.usage }),
      });
    }
  }
  const runtimeStarted = events.some((event) => event.type === 'job.runtime.started');
  return {
    status,
    events: renderedEvents,
    readiness:
      phase === 'queued'
        ? 'queued'
        : phase === 'launching'
          ? 'pending'
          : (phase === 'error' || phase === 'aborted') && !runtimeStarted
            ? 'error'
            : 'ready',
    exit:
      terminalEvent === undefined || terminalBody === null
        ? null
        : {
            ...terminalBody.terminal,
            diagnostics,
            endTime: terminalEvent.ts,
          },
  };
}

export function seedHistoricalEpoch(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>,
  index: JobLocationIndex,
  epoch: ResolvedStoreEpoch,
  epochKey: string,
  fingerprint: string,
  jobsRoot: string,
  storage: StoragePort,
  knownJobs: readonly KnownHistoricalJob[] = [],
  certifyRetiredEpoch = false,
): HistoricalSeedResult {
  const sources = historicalSources.get(index) ?? new Map<string, HistoricalEpochSource>();
  const source: HistoricalEpochSource = { runtime, originalEpoch: epoch, fingerprint, jobsRoot, storage };
  sources.set(epochKey, source);
  historicalSources.set(index, sources);
  for (const known of knownJobs) {
    index.register(known.jobId, epochKey, known.subject);
  }
  let addressedEpoch: ResolvedStoreEpoch;
  try {
    const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey ?? epoch.lineageKey ?? epochKey;
    addressedEpoch =
      observeProtectedEpoch({ storage }, epoch.canonicalStoreRoot ?? epoch.storeRoot, lineageKey) ?? epoch;
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error), true);
    for (const location of index.locationsFor(epochKey)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: 'protected-epoch-address-unreadable',
    };
  }
  const reader = readers[fingerprint];
  const dbPath = addressedEpoch.path;
  if (reader === undefined || !storage.existsSync(dbPath)) {
    index.holdUnknownLocations(
      epochKey,
      reader === undefined ? 'unsupported-store-fingerprint' : 'retained-store-root-missing',
    );
    for (const location of index.locationsFor(epochKey)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: reader === undefined ? 'unsupported-store-fingerprint' : 'retained-store-root-missing',
    };
  }
  let releaseLock: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    releaseLock = acquireSharedFileLockSync(join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME));
    db = storage.openSqliteDatabaseSync(dbPath, { readOnly: true });
    const rows = reader(db);
    const highWaterSeq = z
      .object({ seq: z.number().int().nonnegative() })
      .parse(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'").get()).seq;
    const observed = new Set<string>();
    const launches = db
      .prepare(
        "SELECT stream_id, body FROM events WHERE stream_kind = 'job' AND type = 'job.launch.requested' ORDER BY seq ASC",
      )
      .all()
      .map((row) => z.object({ stream_id: z.string(), body: z.instanceof(Uint8Array) }).parse(row));
    for (const launch of launches) {
      const body = launchBodySchema.parse(parseBody(launch.body));
      index.register(launch.stream_id, epochKey, {
        projectRoot: body.projectRoot,
        workDir: body.jobKind === 'kb' ? null : (body.request?.cwd ?? body.projectRoot),
        jobKind: body.jobKind,
      });
    }
    for (const row of rows) {
      observed.add(row.job_id);
      const events = readEvents(db, row.job_id);
      const detail = historicalDetail(db, row, events);
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
      const resultPath = resultPathFor(jobsRoot, row.job_id);
      index.recordTerminal(row.job_id, detail, resultPath, terminal.seq, db as Database);
      try {
        index.resultExportOwnerForSource(db as Database, epochKey, jobsRoot).ensureResultMarkdownArtifact(row.job_id);
      } catch {
        /* Failed publication must not hide a retained terminal or stop hydration of other jobs. */
      }
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
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error), true);
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

export type HistoricalSourceRead =
  | Readonly<{ kind: 'read'; locations: ReadonlyMap<string, JobLocation | null> }>
  | Readonly<{ kind: 'unreadable'; retired?: boolean }>;

export type HistoricalSourceReader = (epochKey: string, jobIds: readonly string[]) => HistoricalSourceRead;

/** Source observation cannot hydrate locations, publish artifacts, or repair the guard. */
export function readHistoricalSource(
  view: JobLocationView,
  epochKey: string,
  jobIds: readonly string[],
): HistoricalSourceRead {
  const source = historicalSources.get(view)?.get(epochKey);
  if (source === undefined) return { kind: 'unreadable', retired: true };
  if (readers[source.fingerprint] === undefined) return { kind: 'unreadable' };
  let release: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    const epoch =
      observeResolvedStoreEpoch({ storage: source.storage }, epochKey) ??
      observeProtectedEpoch(
        { storage: source.storage },
        source.originalEpoch.canonicalStoreRoot ?? source.originalEpoch.storeRoot,
        source.originalEpoch.lineageKey ?? epochKey,
      ) ??
      source.originalEpoch;
    if (!source.storage.existsSync(epoch.path)) return { kind: 'unreadable', retired: true };
    release = acquireSharedFileLockNoRepairSync(join(dirname(epoch.path), STORE_LOCK_FILE_NAME));
    const identity = epochKey.startsWith('{')
      ? inspectResolvedStoreEpochKey({ storage: source.storage }, epoch)
      : inspectEpochKey({ storage: source.storage }, epoch);
    if (identity !== epochKey) return { kind: 'unreadable' };
    db = source.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true });
    db.exec('BEGIN');
    const locations = new Map<string, JobLocation | null>();
    for (const jobId of jobIds) {
      const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
      const events = readEvents(db, jobId);
      if (raw === undefined) {
        if (events.some((event) => event.type === 'job.terminal.recorded')) return { kind: 'unreadable' };
        locations.set(jobId, null);
        continue;
      }
      const row = (source.fingerprint === FINGERPRINT_0110 ? newerProjectionSchema : olderProjectionSchema).parse(raw);
      const detail = historicalDetail(db, row, events);
      const terminal = detail.events.find((event) => event.type === 'terminal');
      const location: JobLocation = {
        version: 'v1',
        jobId,
        epochKey,
        subject: {
          projectRoot: detail.status.projectRoot,
          workDir: detail.status.workDir,
          jobKind: detail.status.jobKind,
        },
        disposition: terminal === undefined ? 'unresolved' : 'terminal',
        ...(terminal === undefined
          ? {}
          : { terminalSeq: terminal.seq, resultPath: resultPathFor(source.jobsRoot, jobId) }),
        detail: { kind: 'recorded', value: { ...detail, epochKey } },
      };
      if (terminal !== undefined && !hasReadableTerminalDetail(location)) return { kind: 'unreadable' };
      locations.set(jobId, location);
    }
    return { kind: 'read', locations };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    db?.close();
    release?.();
  }
}

export function historicalSourceReader(index: JobLocationIndex): HistoricalSourceReader {
  return (epochKey, jobIds) => readHistoricalSource(index, epochKey, jobIds);
}

/** Hydration belongs to lifecycle owners before source retirement. */
export function refreshHistoricalEpochs(index: JobLocationIndex): void {
  for (const epochKey of historicalSources.get(index)?.keys() ?? []) {
    refreshHistoricalEpoch(
      index,
      epochKey,
      index.locationsFor(epochKey).map((location) => location.jobId),
    );
  }
}

export function refreshHistoricalEpoch(
  index: JobLocationIndex,
  epochKey: string,
  jobIds: readonly string[],
): 'read' | 'unreadable' {
  const source = historicalSources.get(index)?.get(epochKey);
  if (source === undefined) return 'unreadable';
  if (index.unknownLocationHold(epochKey) !== null) return 'unreadable';
  let addressedEpoch: ResolvedStoreEpoch;
  try {
    const { runtime, originalEpoch } = source;
    const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey ?? originalEpoch.lineageKey ?? epochKey;
    addressedEpoch =
      observeProtectedEpoch(
        { storage: source.storage },
        originalEpoch.canonicalStoreRoot ?? originalEpoch.storeRoot,
        lineageKey,
      ) ?? originalEpoch;
  } catch {
    return 'unreadable';
  }
  const reader = readers[source.fingerprint];
  const dbPath = addressedEpoch.path;
  if (reader === undefined || !source.storage.existsSync(dbPath)) return 'unreadable';

  let releaseLock: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    releaseLock = acquireSharedFileLockSync(join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME), 0);
    db = source.storage.openSqliteDatabaseSync(dbPath, { readOnly: true });
    const requested = new Set(jobIds);
    for (const row of reader(db)) {
      if (!requested.has(row.job_id)) continue;
      requested.delete(row.job_id);
      const location = index.read(row.job_id);
      if (
        location === null ||
        location.epochKey !== epochKey ||
        (location.disposition === 'terminal' && hasReadableTerminalDetail(location))
      )
        continue;
      const detail = historicalDetail(db, row, readEvents(db, row.job_id));
      const terminal = [...detail.events].reverse().find((event) => event.type === 'terminal');
      if (!isTerminalPhase(detail.status.phase) || detail.exit === null || terminal === undefined) {
        index.recordObserved(row.job_id, detail);
        continue;
      }
      const resultPath = resultPathFor(source.jobsRoot, row.job_id);
      index.recordTerminal(row.job_id, detail, resultPath, terminal.seq, db as Database);
      try {
        index
          .resultExportOwnerForSource(db as Database, epochKey, source.jobsRoot)
          .ensureResultMarkdownArtifact(row.job_id);
      } catch {
        /* Failed publication must not hide a retained terminal. */
      }
    }
    for (const jobId of requested) {
      if (readEvents(db, jobId).some((event) => event.type === 'job.terminal.recorded')) return 'unreadable';
    }
    const highWaterSeq = z
      .object({ seq: z.number().int().nonnegative() })
      .parse(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'").get()).seq;
    index.certify(epochKey, highWaterSeq);
    return 'read';
  } catch {
    // An unreadable refresh cannot certify absence or void an earlier terminal certificate.
    return 'unreadable';
  } finally {
    db?.close();
    releaseLock?.();
  }
}
