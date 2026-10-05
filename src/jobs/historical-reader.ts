import { waitReadPosition, waitEpochToken } from './wait/cursor.js';
import type { WaitStreamRequest } from './wait/contract.js';
import { epochIdentity, sameEpoch } from '../store/epoch/identity.js';
import { setImmediate } from 'node:timers/promises';
import { hasReadableTerminalDetail } from './terminal/identity.js';
import type { SourceReadDisposition } from './wait/session.js';
import { HistoricalDecodeError, sourceReadFailureDisposition } from './source-read.js';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireSharedFileLockNoRepairSync, createSharedFileLockSync } from '../infra/fs-lock.js';
import type { SqliteDatabasePort, StoragePort } from '../infra/port-types.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import type { Runtime } from '../runtime/ports.js';
import { type StoreEpochListEntry, STORE_LOCK_FILE_NAME, type ResolvedStoreEpoch } from '../store/epoch/index.js';
import {
  observeProtectedEpoch,
  observeResolvedStoreEpoch,
  inspectResolvedStoreEpochKey,
} from '../store/epoch/index.js';
import { inspectEpochKey } from '../store/epoch/key.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import {
  type JobLocationIndex,
  type JobLocationSubject,
  type JobLocationView,
  type JobLocation,
} from './location-index.js';
import { phaseForOutcome, jobProgressFaultSchema } from './outcome.js';
import { aggregateWorkflowUsage } from './workflow-usage.js';
import type { Database } from '../store/db.js';
import { observeStorePath } from '../store/path-observation.js';
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
type HistoricalReader = (db: SqliteDatabasePort) => unknown[];
type HistoricalReadFrontier = { frontier: number; events: z.infer<typeof eventSchema>[]; location: JobLocation | null };

type HistoricalEpochSource = {
  readonly epochKey: string;
  readonly runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>;
  readonly originalEpoch: ResolvedStoreEpoch;
  readonly fingerprint: string;
  readonly jobsRoot: string;
  readonly storage: StoragePort;
  attempts: number;
  refreshAttempts: number;
  readCache?: WeakMap<object, Map<string, HistoricalReadFrontier>>;
  sweep?: { revision: number; frontier: number };
  retired?: boolean;
  refreshPending?: { jobIds: string[]; frontier: number };
  seed?: {
    frontier?: number;
    rows?: { job_id: string }[];
    launches?: { stream_id: string; seq: number }[];
    members?: ReadonlySet<string>;
    recordingError?: Error;
    failedRowOffset?: number;
    failures?: number;
    rowOffset: number;
    knownJobs: readonly KnownHistoricalJob[];
    certify: boolean;
  };
};
const registrationAttempts = new WeakMap<JobLocationView, Map<string, number>>();
const retiredHistoricalEpochs = new WeakMap<JobLocationView, Set<string>>();
const historicalSources = new WeakMap<JobLocationView, Map<string, HistoricalEpochSource>>();
const hydrationListeners = new WeakMap<JobLocationIndex, (epochKey: string) => void>();

export function onHistoricalHydrationHint(
  index: JobLocationIndex,
  listener: ((epochKey: string) => void) | null,
): void {
  if (listener) hydrationListeners.set(index, listener);
  else hydrationListeners.delete(index);
}

export function hintHistoricalHydration(index: JobLocationIndex, jobId: string): void {
  const location = index.read(jobId);
  if (!location || hasReadableTerminalDetail(location) || index.unknownLocationHold(location.epochKey)) return;
  if (!historicalSources.get(index)?.has(epochIdentity(location.epochKey))) return;
  hydrationListeners.get(index)?.(location.epochKey);
}

function holdSourceFailure(
  index: JobLocationIndex,
  epochKey: string,
  error: unknown,
  attempts: number,
  deterministicData = true,
): string {
  const deterministic = deterministicData && sourceReadFailureDisposition(error) === 'settled-unreadable';
  const reason =
    sourceReadFailureDisposition(error) === 'settled-unreadable'
      ? 'Retained source data cannot be decoded by this build'
      : 'Retained source cannot be observed';
  const retryScheduled = !deterministic && attempts < 3;
  const message = retryScheduled
    ? `${reason}; probe ${attempts} of 3 failed; epoch maintenance probes every 5 s and settles after the third consecutive failure`
    : `${reason}; this coordinator will not re-read it before its next start${deterministic ? '' : ' after 3 maintenance attempts'}`;
  index.holdUnknownLocations(epochKey, message, retryScheduled);
  return message;
}
function retireHistoricalSource(index: JobLocationIndex, epochKey: string, source: HistoricalEpochSource): void {
  source.retired = true;
  source.readCache = undefined;
  const retired = retiredHistoricalEpochs.get(index) ?? new Set<string>();
  retired.add(epochIdentity(epochKey));
  retiredHistoricalEpochs.set(index, retired);
  const locations = index.locationsFor(epochKey);
  if (index.certificate(epochKey) || locations.every(hasReadableTerminalDetail)) {
    index.clearUnknownLocations(epochKey);
    historicalSources.get(index)?.delete(epochIdentity(epochKey));
  } else if (index.unknownLocationHold(epochKey)) {
    index.holdUnknownLocations(epochKey, 'Source retired; no further source read is possible', false);
  }
  for (const location of locations) if (!hasReadableTerminalDetail(location)) index.markUnresolved(location.jobId);
}

export async function retryUnknownHistoricalEpochs(
  index: JobLocationIndex,
  budget?: { remaining: number },
): Promise<void> {
  const sources = historicalSources.get(index);
  for (const source of sources?.values() ?? []) {
    const epochKey = source.epochKey;
    if (budget) {
      await setImmediate();
      budget.remaining = 16;
    }
    if (source.retired) continue;
    try {
      const epoch = resolveHistoricalAddress(source, epochKey);
      if (observeHistoricalPath(source, epochKey, epoch) === 'absent') {
        retireHistoricalSource(index, epochKey, source);
        continue;
      }
      if (
        index.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.retryScheduled === false &&
        (!source.seed || source.attempts >= 3)
      )
        continue;
      if (!source.seed) {
        source.attempts = 0;
        continue;
      }
      void seedHistoricalEpoch(
        source.runtime,
        index,
        source.originalEpoch,
        epochKey,
        source.fingerprint,
        source.jobsRoot,
        source.storage,
        source.seed?.knownJobs,
        source.seed?.certify,
        budget,
      );
    } catch (error) {
      try {
        holdSourceFailure(index, epochKey, error, ++source.attempts, false);
      } catch {
        // One held epoch must not prevent retrying others.
      }
    }
  }
}
export type KnownHistoricalJob = Readonly<{ jobId: string; subject: JobLocationSubject }>;
export type HistoricalSeedResult =
  | Readonly<{ kind: 'complete'; jobIds: readonly string[] }>
  | Readonly<{ kind: 'uncertified'; knownJobIds: readonly string[] }>
  | Readonly<{ kind: 'unrecoverable-retained'; knownJobIds: readonly string[]; reason: string }>;

function read0100(db: SqliteDatabasePort): unknown[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all();
}

function read0105(db: SqliteDatabasePort): unknown[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all();
}

function read0110(db: SqliteDatabasePort): unknown[] {
  return db.prepare('SELECT * FROM projection_jobs ORDER BY job_id ASC').all();
}

const readers: Readonly<Record<string, HistoricalReader>> = {
  [FINGERPRINT_0100]: read0100,
  [FINGERPRINT_0105]: read0105,
  [FINGERPRINT_0110]: read0110,
};

function readEvents(
  db: SqliteDatabasePort,
  jobId: string,
  afterSeq = 0,
  window?: { tail?: number; limit?: number },
): z.infer<typeof eventSchema>[] {
  const events = db
    .prepare(
      `SELECT seq, ts, type, body FROM events
    WHERE stream_kind = 'job' AND stream_id = ? AND seq > ?
    AND type IN ('job.launch.requested', 'job.progress.emitted', 'job.runtime.started', 'job.terminal.recorded')
    ORDER BY seq ${window?.tail !== undefined ? 'DESC' : 'ASC'}${window ? ` LIMIT ${Math.max(1, Math.min(501, (window.tail ?? window.limit ?? 500) + 3))}` : ''}`,
    )
    .all(jobId, afterSeq)
    .map((row) => eventSchema.parse(row));
  if (window) {
    const metadata = db
      .prepare(
        "SELECT seq, ts, type, body FROM events WHERE seq IN (SELECT MAX(seq) FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type IN ('job.launch.requested', 'job.runtime.started', 'job.terminal.recorded') GROUP BY type) ORDER BY seq ASC",
      )
      .all(jobId)
      .map((row) => eventSchema.parse(row));
    for (const row of metadata) if (!events.some((event) => event.seq === row.seq)) events.push(row);
    events.sort((a, b) => a.seq - b.seq);
  }
  return events;
}

function parseBody(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

function diagnosticsFrom(raw: string): JobDiagnostics {
  return jobDiagnosticsSchema.parse(JSON.parse(raw) as unknown);
}

function historicalProgressFaults(row: Projection, events: readonly z.infer<typeof eventSchema>[]) {
  const recorded = events
    .filter((event) => event.type === 'job.progress.emitted')
    .map((event) => jobProgressFaultSchema.safeParse(parseBody(event.body)))
    .flatMap((fault) => (fault.success ? [fault.data] : []));
  if (events.some((event) => event.type === 'job.launch.requested')) return recorded;
  const retained = [...diagnosticsFrom(row.diagnostics).progressFaults];
  const unmatched = [...retained];
  for (const fault of recorded) {
    const index = unmatched.findIndex((known) => JSON.stringify(known) === JSON.stringify(fault));
    if (index >= 0) unmatched.splice(index, 1);
    else retained.push(fault);
  }
  return retained;
}

function historicalDetail(
  db: SqliteDatabasePort,
  row: Projection,
  events: readonly z.infer<typeof eventSchema>[],
  previous?: { frontier: number; detail: JobDetailResponse },
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
          progressFaults: historicalProgressFaults(row, events),
          ...jobDiagnosticsSchema.omit({ progressFaults: true }).parse(terminalBody.diagnostics ?? {}),
        };
  if (jobKind === 'workflow') {
    const usage = aggregateWorkflowUsage(db as Database, row.job_id);
    if (usage !== undefined) diagnostics.usage = usage;
  }
  const renderedEvents: JobEvent[] = [...(previous?.detail.events ?? [])];
  for (const event of events) {
    if (previous && event.seq <= previous.frontier) continue;
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

function resolveHistoricalAddress(source: HistoricalEpochSource, epochKey: string): ResolvedStoreEpoch {
  const { originalEpoch, storage } = source;
  const lineageKey =
    observeResolvedStoreEpoch(source.runtime, epochKey)?.lineageKey ?? originalEpoch.lineageKey ?? epochKey;
  const resolveAddress = (): ResolvedStoreEpoch =>
    observeProtectedEpoch({ storage }, originalEpoch.canonicalStoreRoot ?? originalEpoch.storeRoot, lineageKey) ??
    observeResolvedStoreEpoch({ storage }, epochKey) ??
    originalEpoch;
  const epoch = resolveAddress();
  if (observeStorePath(storage, epoch.path) === 'present') return epoch;
  const latest = resolveAddress();
  if (latest.path !== epoch.path || observeStorePath(storage, latest.path) === 'present')
    throw new Error('Source protection moved during observation; retry its address');
  return latest;
}

function observeHistoricalPath(
  source: HistoricalEpochSource,
  epochKey: string,
  epoch: ResolvedStoreEpoch,
): 'present' | 'absent' {
  const state = observeStorePath(source.storage, epoch.path);
  if (state === 'present') return state;
  const latest = resolveHistoricalAddress(source, epochKey);
  if (latest.path !== epoch.path || observeStorePath(source.storage, latest.path) === 'present')
    throw new Error('Source protection moved during observation; retry its address');
  return 'absent';
}

function verifyHistoricalIdentity(source: HistoricalEpochSource, epochKey: string, epoch: ResolvedStoreEpoch): void {
  const identity = epochKey.startsWith('{')
    ? inspectResolvedStoreEpochKey({ storage: source.storage }, epoch)
    : inspectEpochKey({ storage: source.storage }, epoch);
  if (!sameEpoch(identity, epochKey)) throw new Error('Source epoch identity cannot be confirmed');
}

export function registerPresentHistoricalEpochs(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env' | 'paths'>,
  index: JobLocationIndex,
  entries: readonly (Pick<StoreEpochListEntry, 'resolved' | 'epochKey' | 'epochJson'> & { epoch?: string })[],
  activeEpochKey: string | null,
  budget?: { remaining: number },
): void {
  const attempts = registrationAttempts.get(index) ?? new Map<string, number>();
  registrationAttempts.set(index, attempts);
  for (const entry of entries) {
    const resolved =
      entry.resolved ??
      (entry.epoch
        ? {
            storeRoot: runtime.paths.coral.store.dbDir,
            epoch: entry.epoch,
            path: join(runtime.paths.coral.store.dbDir, `epoch-${entry.epoch}`, 'store.db'),
          }
        : null);
    if (!resolved) continue;
    const fallback =
      entry.epochKey ?? JSON.stringify({ storeRoot: resolved.storeRoot, epoch: resolved.epoch, path: resolved.path });
    let address = resolved.path;
    try {
      const storeRoot = runtime.storage.realpathSync(resolved.canonicalStoreRoot ?? resolved.storeRoot);
      address = join(storeRoot, `epoch-${resolved.epoch}`, 'store.db');
      if ((attempts.get(address) ?? 0) >= 3) continue;
      if (observeStorePath(runtime.storage, resolved.path) === 'absent') continue;
      const key = inspectResolvedStoreEpochKey(runtime, { ...resolved, canonicalStoreRoot: storeRoot });
      if (!key) throw new Error('Source identity cannot be observed');
      attempts.delete(address);
      if (sameEpoch(key, activeEpochKey) || historicalSources.get(index)?.has(epochIdentity(key))) continue;
      const fingerprint = entry.epochJson.kind === 'valid' ? entry.epochJson.value.build.storeFormatFingerprint : '';
      const certificate = index.certificate(key);
      if (certificate) {
        const sources = historicalSources.get(index) ?? new Map<string, HistoricalEpochSource>();
        sources.set(epochIdentity(key), {
          epochKey: key,
          runtime,
          originalEpoch: resolved,
          fingerprint,
          jobsRoot: runtime.paths.coral.exports.jobsRoot,
          storage: runtime.storage,
          attempts: 0,
          refreshAttempts: 0,
          sweep: { revision: certificate.revision, frontier: certificate.terminalHighWaterSeq },
        });
        historicalSources.set(index, sources);
        continue;
      }
      void seedHistoricalEpoch(
        runtime,
        index,
        resolved,
        key,
        fingerprint,
        runtime.paths.coral.exports.jobsRoot,
        runtime.storage,
        [],
        false,
        budget,
      );
    } catch {
      const count = (attempts.get(address) ?? 0) + 1;
      attempts.set(address, count);
      try {
        index.holdUnknownLocations(
          fallback,
          count < 3
            ? `Source identity unreadable; epoch maintenance retries every 5 s and settles after 3 consecutive failures (attempt ${count} of 3)`
            : 'Source identity unreadable; epoch maintenance settled after 3 consecutive failures; re-read at next start',
          count < 3,
        );
      } catch {
        /* An unobservable entry must not stop registration of other epochs. */
      }
    }
  }
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
  budget?: { remaining: number },
): HistoricalSeedResult {
  const sources = historicalSources.get(index) ?? new Map<string, HistoricalEpochSource>();
  const seed: NonNullable<HistoricalEpochSource['seed']> = sources.get(epochIdentity(epochKey))?.seed ?? {
    rowOffset: 0,
    knownJobs,
    certify: certifyRetiredEpoch,
  };
  const source: HistoricalEpochSource = sources.get(epochIdentity(epochKey)) ?? {
    epochKey,
    runtime,
    originalEpoch: epoch,
    fingerprint,
    jobsRoot,
    storage,
    attempts: 0,
    refreshAttempts: 0,
  };
  source.seed = seed;
  source.attempts++;
  retiredHistoricalEpochs.get(index)?.delete(epochIdentity(epochKey));
  sources.set(epochIdentity(epochKey), source);
  historicalSources.set(index, sources);
  if (budget && budget.remaining <= 0) {
    source.attempts--;
    if (!index.unknownLocationHold(epochKey))
      index.holdUnknownLocations(
        epochKey,
        'Historical hydration is pending; epoch maintenance continues every 5 s, with at most 16 jobs per slice and settlement after 3 consecutive failed observations',
        true,
      );
    return { kind: 'uncertified', knownJobIds: [] };
  }
  let addressedEpoch: ResolvedStoreEpoch;
  try {
    addressedEpoch = resolveHistoricalAddress(source, epochKey);
  } catch (error: unknown) {
    for (const known of knownJobs) {
      if (index.read(known.jobId)) continue;
      if (budget && budget.remaining <= 0) break;
      if (budget) budget.remaining--;
      index.register(known.jobId, epochKey, known.subject);
    }
    holdSourceFailure(index, epochKey, error, source.attempts, false);
    for (const location of index.locationsFor(epochKey))
      if (!hasReadableTerminalDetail(location)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: 'protected-epoch-address-unreadable',
    };
  }
  const reader = readers[fingerprint];
  const dbPath = addressedEpoch.path;
  let releaseLock: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    if (observeHistoricalPath(source, epochKey, addressedEpoch) === 'absent') {
      for (const known of knownJobs) {
        if (index.read(known.jobId)) continue;
        if (budget && budget.remaining <= 0) break;
        if (budget) budget.remaining--;
        index.register(known.jobId, epochKey, known.subject);
      }
      retireHistoricalSource(index, epochKey, source);
      return {
        kind: 'unrecoverable-retained',
        knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
        reason: 'Source retired; no further source read is possible',
      };
    }
    if (reader === undefined) {
      index.holdUnknownLocations(
        epochKey,
        `Store fingerprint ${fingerprint} cannot be read by this build; this coordinator will not re-read it before its next start`,
      );
      for (const location of index.locationsFor(epochKey))
        if (!hasReadableTerminalDetail(location)) index.markUnresolved(location.jobId);
      return {
        kind: 'unrecoverable-retained',
        knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
        reason: `Store fingerprint ${fingerprint} cannot be read by this build; this coordinator will not re-read it before its next start`,
      };
    }
    const lockPath = join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME);
    if (storage.existsSync(lockPath)) {
      const guard = storage.lstatSync(lockPath, { bigint: true });
      if (!guard.isFile() || guard.nlink !== 1n) throw new Error('Source lock is malformed.');
    }
    releaseLock = createSharedFileLockSync(lockPath);
    verifyHistoricalIdentity(source, epochKey, addressedEpoch);
    db = storage.openSqliteDatabaseSync(dbPath, { readOnly: true });
    db.exec('BEGIN');
    const rows = (seed.rows ??= db.prepare('SELECT job_id FROM projection_jobs ORDER BY job_id ASC').all() as {
      job_id: string;
    }[]);
    const highWaterSeq = z
      .object({ seq: z.number().int().nonnegative() })
      .parse(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'").get()).seq;
    seed.frontier ??= (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
    const observed = new Set<string>();

    const launches = (seed.launches ??= db
      .prepare(
        "SELECT stream_id, seq FROM events WHERE stream_kind = 'job' AND type = 'job.launch.requested' ORDER BY seq ASC",
      )
      .all() as { stream_id: string; seq: number }[]);
    seed.members ??= new Set([...launches.map((launch) => launch.stream_id), ...rows.map((row) => row.job_id)]);
    const pending = (): HistoricalSeedResult => {
      source.attempts = 0;
      index.holdUnknownLocations(
        epochKey,
        'Historical hydration is pending; epoch maintenance continues it every 5 s',
        true,
      );
      return { kind: 'uncertified', knownJobIds: [...observed] };
    };
    const subjects = [
      ...new Set([
        ...launches.map((launch) => launch.stream_id),
        ...rows.map((row) => row.job_id),
        ...knownJobs.map((job) => job.jobId),
      ]),
    ];
    const launchById = new Map(launches.map((launch) => [launch.stream_id, launch]));
    for (let i = seed.rowOffset; i < subjects.length; i++) {
      const jobId = subjects[i];
      const retained = index.read(jobId);
      if (retained && sameEpoch(retained.epochKey, epochKey) && hasReadableTerminalDetail(retained)) {
        if (!storage.existsSync(resultPathFor(jobsRoot, jobId))) {
          if (budget) {
            if (budget.remaining <= 0) return pending();
            budget.remaining--;
          }
          try {
            index.resultExportOwnerForSource(db as Database, epochKey, jobsRoot).ensureResultMarkdownArtifact(jobId);
          } catch {
            /* Publication failure cannot hide the retained outcome. */
          }
        }
        observed.add(jobId);
        seed.rowOffset = i + 1;
        continue;
      }
      if (budget) {
        if (budget.remaining <= 0) return pending();
        budget.remaining--;
      }
      try {
        let registered = false;
        const launch = launchById.get(jobId);
        if (launch) {
          const row = z
            .object({ body: z.instanceof(Uint8Array) })
            .parse(db.prepare('SELECT stream_id, body FROM events WHERE seq = ?').get(launch.seq));
          const body = launchBodySchema.parse(parseBody(row.body));
          index.register(jobId, epochKey, {
            projectRoot: body.projectRoot,
            workDir: body.jobKind === 'kb' ? null : (body.request?.cwd ?? body.projectRoot),
            jobKind: body.jobKind,
          });
          registered = true;
        } else {
          const known = knownJobs.find((job) => job.jobId === jobId);
          if (known) {
            index.register(jobId, epochKey, known.subject);
            registered = true;
          }
        }
        const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
        if (raw === undefined) {
          index.markUnresolved(jobId);
          observed.add(jobId);
          continue;
        }
        const row = (fingerprint === FINGERPRINT_0110 ? newerProjectionSchema : olderProjectionSchema).parse(raw);
        const events = readEvents(db, jobId);
        const detail = historicalDetail(db, row, events);
        if (!registered)
          index.register(jobId, epochKey, {
            projectRoot: detail.status.projectRoot,
            workDir: detail.status.workDir,
            jobKind: detail.status.jobKind,
          });
        observed.add(jobId);
        const terminal = [...detail.events].reverse().find((event) => event.type === 'terminal');
        if (!isTerminalPhase(detail.status.phase) || detail.exit === null || terminal === undefined) {
          index.recordObserved(jobId, detail);
          index.markUnresolved(jobId);
          continue;
        }
        index.recordTerminal(jobId, detail, resultPathFor(jobsRoot, jobId), terminal.seq, db as Database);
        try {
          index.resultExportOwnerForSource(db as Database, epochKey, jobsRoot).ensureResultMarkdownArtifact(jobId);
        } catch {
          /* Publication failure cannot hide the retained outcome. */
        }
      } catch (error) {
        seed.recordingError ??= error instanceof Error ? error : new Error(String(error));
        seed.failedRowOffset ??= i;
        index.markUnresolved(jobId);
        index.resultRepairFailures.add(jobId);
      } finally {
        seed.rowOffset = i + 1;
      }
    }
    for (const jobId of subjects) observed.add(jobId);
    if (seed.recordingError !== undefined) {
      if (seed.failedRowOffset !== undefined) seed.rowOffset = seed.failedRowOffset;
      source.attempts = (seed.failures ?? 0) + 1;
      seed.failures = source.attempts;
      const error = seed.recordingError;
      seed.recordingError = undefined;
      seed.failedRowOffset = undefined;
      throw error;
    }
    index.clearUnknownLocations(epochKey);
    source.seed = undefined;
    source.attempts = 0;
    source.refreshAttempts = 0;
    source.sweep = { revision: index.revision(epochKey), frontier: seed.frontier };
    if (!certifyRetiredEpoch) return { kind: 'uncertified', knownJobIds: [...observed] };
    const certificate = index.certify(epochKey, highWaterSeq);
    return certificate === null
      ? { kind: 'unrecoverable-retained', knownJobIds: [...observed], reason: 'known-jobs-unresolved' }
      : { kind: 'complete', jobIds: certificate.jobIds };
  } catch (error: unknown) {
    holdSourceFailure(index, epochKey, error, source.attempts);
    for (const location of index.locationsFor(epochKey))
      if (!hasReadableTerminalDetail(location)) index.markUnresolved(location.jobId);
    return {
      kind: 'unrecoverable-retained',
      knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
      reason: index.unknownLocationHold(epochKey) ?? 'retained-store-unreadable',
    };
  } finally {
    db?.close();
    releaseLock?.();
  }
}

/** SELECT * and the historical decoder support both released projection fingerprints. */
export function readHistoricalJobDetail(db: SqliteDatabasePort | Database, jobId: string): JobDetailResponse | null {
  const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
  if (raw === undefined) return null;
  return historicalDetail(
    db as SqliteDatabasePort,
    olderProjectionSchema.parse(raw),
    readEvents(db as SqliteDatabasePort, jobId),
  );
}

export type HistoricalSourceRead =
  | Readonly<{
      kind: 'read';
      locations: ReadonlyMap<string, JobLocation | null>;
      dispositions: ReadonlyMap<string, SourceReadDisposition>;
      unreadableJobs?: ReadonlySet<string>;
      absentJobs?: ReadonlySet<string>;
    }>
  | Readonly<{
      kind: 'unreadable';
      disposition: Exclude<SourceReadDisposition, 'readable'>;
      reason?: string;
      retired?: boolean;
    }>;

export type HistoricalSourceReader = (
  epochKey: string,
  jobIds: readonly string[],
  session?: object,
) => HistoricalSourceRead;

/** Source observation cannot hydrate locations, publish artifacts, or repair the guard. */
export function readHistoricalSource(
  view: JobLocationView,
  epochKey: string,
  jobIds: readonly string[],
  session?: object,
): HistoricalSourceRead {
  const source = historicalSources.get(view)?.get(epochIdentity(epochKey));
  if (source === undefined) {
    const hold = view.unknownLocationHolds().find((hold) => {
      if (sameEpoch(hold.epochKey, epochKey)) return true;
      try {
        const left = JSON.parse(hold.epochKey ?? '') as { storeRoot?: string; epoch?: string; lineageKey?: string };
        const right = JSON.parse(epochKey) as { storeRoot?: string; epoch?: string };
        return left.lineageKey === undefined && left.storeRoot === right.storeRoot && left.epoch === right.epoch;
      } catch {
        return false;
      }
    });
    const state = view.historicalSourceState?.(epochKey);
    const absent = state === 'absent' && view.historicalSourceState?.(epochKey) === 'absent';
    return retiredHistoricalEpochs.get(view)?.has(epochIdentity(epochKey)) || absent
      ? { kind: 'unreadable', disposition: 'retired', retired: true }
      : {
          kind: 'unreadable',
          disposition: hold?.retryScheduled === false ? 'settled-unreadable' : 'transient-unknown',
          reason:
            hold?.reason ??
            (view.historicalSourceState?.(epochKey) === 'present'
              ? `Epoch ${waitEpochToken(epochKey).slice(0, 8)} is present but not yet registered by this coordinator; epoch maintenance registers present epochs every 5 s`
              : `Epoch ${waitEpochToken(epochKey).slice(0, 8)} cannot be observed by this coordinator; epoch maintenance re-observes it every 5 s and settles after 3 consecutive failures`),
        };
  }
  if (source.retired) return { kind: 'unreadable', disposition: 'retired', retired: true };
  if (readers[source.fingerprint] === undefined)
    return {
      kind: 'unreadable',
      disposition: 'settled-unreadable',
      reason:
        'This build cannot read the retained source format; epoch maintenance re-reads it at the next coordinator start',
    };
  let release: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    const epoch = resolveHistoricalAddress(source, epochKey);
    if (observeHistoricalPath(source, epochKey, epoch) === 'absent')
      return { kind: 'unreadable', disposition: 'retired', retired: true };
    release = acquireSharedFileLockNoRepairSync(join(dirname(epoch.path), STORE_LOCK_FILE_NAME));
    verifyHistoricalIdentity(source, epochKey, epoch);
    db = source.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true });
    db.exec('BEGIN');
    const frontier = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
    if (session) source.readCache ??= new WeakMap();
    const readCache =
      (session ? source.readCache?.get(session) : undefined) ?? new Map<string, HistoricalReadFrontier>();
    if (session && source.readCache) source.readCache.set(session, readCache);
    const locations = new Map<string, JobLocation | null>();
    const unreadableJobs = new Set<string>();
    const absentJobs = new Set<string>();
    const dispositions = new Map<string, SourceReadDisposition>();
    for (const jobId of jobIds) {
      try {
        dispositions.set(jobId, 'readable');
        if (source.seed?.members && source.seed.frontier === frontier && !source.seed.members.has(jobId)) {
          locations.set(jobId, null);
          absentJobs.add(jobId);
          continue;
        }
        const cached = readCache.get(jobId);
        if (cached?.frontier === frontier) {
          locations.set(jobId, cached.location);
          continue;
        }
        const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
        const prior = cached && cached.frontier < frontier ? cached : undefined;
        const request = session && 'jobIds' in session ? (session as WaitStreamRequest) : undefined;
        const position = request ? waitReadPosition(request, jobId, epochKey) : { afterSeq: 0 };
        const events = [
          ...(prior?.events ?? []),
          ...readEvents(
            db,
            jobId,
            Math.max(prior?.frontier ?? 0, position.afterSeq),
            position.tail !== undefined || position.limit !== undefined ? position : undefined,
          ),
        ];
        if (raw === undefined) {
          if (events.some((event) => event.type === 'job.terminal.recorded'))
            throw new HistoricalDecodeError('Historical job terminal cannot be decoded');
          locations.set(jobId, null);
          readCache.set(jobId, { frontier, events, location: null });
          continue;
        }
        const row = (source.fingerprint === FINGERPRINT_0110 ? newerProjectionSchema : olderProjectionSchema).parse(
          raw,
        );
        const detail = historicalDetail(
          db,
          row,
          events,
          prior?.location?.detail.kind === 'recorded'
            ? { frontier: prior.frontier, detail: prior.location.detail.value }
            : undefined,
        );
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
        if (terminal !== undefined && !hasReadableTerminalDetail(location))
          throw new HistoricalDecodeError('Historical job terminal cannot be decoded');
        locations.set(jobId, location);
        readCache.set(jobId, {
          frontier,
          events: events.filter(
            (event) =>
              event.type !== 'job.progress.emitted' || jobProgressFaultSchema.safeParse(parseBody(event.body)).success,
          ),
          location,
        });
      } catch (error) {
        dispositions.set(
          jobId,
          view.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.retryScheduled === false
            ? 'settled-unreadable'
            : sourceReadFailureDisposition(error),
        );
        unreadableJobs.add(jobId);
      }
    }
    const result = { kind: 'read', locations, dispositions, unreadableJobs, absentJobs } as const;
    return result;
  } catch (error) {
    const hold = view.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey));
    return {
      kind: 'unreadable',
      disposition: hold?.retryScheduled === false ? 'settled-unreadable' : 'transient-unknown',
      reason:
        hold?.retryScheduled === false
          ? hold.reason
          : error instanceof Error
            ? 'Source cannot be read; epoch maintenance probes every 5 s and settles after 3 consecutive failed probes'
            : 'Source cannot be read; epoch maintenance probes this source every 5 s and settles after 3 failed probes',
    };
  } finally {
    db?.close();
    release?.();
  }
}

export function historicalSourceReader(index: JobLocationIndex): HistoricalSourceReader {
  return (epochKey, jobIds, session) => readHistoricalSource(index, epochKey, jobIds, session);
}

/** Hydration belongs to lifecycle owners before source retirement. */
export async function refreshHistoricalEpochs(index: JobLocationIndex, budget?: { remaining: number }): Promise<void> {
  for (const source of historicalSources.get(index)?.values() ?? []) {
    const epochKey = source.epochKey;
    if (budget) {
      await setImmediate();
      budget.remaining = 16;
    }
    if (source.retired || source.seed) continue;
    try {
      const epoch = resolveHistoricalAddress(source, epochKey);
      if (observeHistoricalPath(source, epochKey, epoch) === 'absent') {
        retireHistoricalSource(index, epochKey, source);
        continue;
      }
      if (index.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.retryScheduled === false)
        continue;
      const locations = source.sweep?.revision === index.revision(epochKey) ? [] : index.locationsFor(epochKey);
      const result = refreshHistoricalEpoch(
        index,
        epochKey,
        locations.map((location) => location.jobId),
        budget,
      );
      if (result.kind === 'read') {
        source.refreshAttempts = 0;
        if (!source.refreshPending) index.clearUnknownLocations(epochKey);
      } else holdSourceFailure(index, epochKey, new Error(result.reason), ++source.refreshAttempts, false);
    } catch (error) {
      try {
        holdSourceFailure(index, epochKey, error, ++source.refreshAttempts, false);
      } catch {
        // A failed hold write must not stop other epochs or the retirement sweep.
      }
    }
  }
}

export function refreshHistoricalEpoch(
  index: JobLocationIndex,
  epochKey: string,
  jobIds: readonly string[],
  budget?: { remaining: number },
): { kind: 'read' } | { kind: 'unreadable'; reason: string } {
  const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
  if (source === undefined) return { kind: 'unreadable', reason: 'Source is not registered' };
  if (source.seed) return { kind: 'unreadable', reason: 'Historical hydration has not completed' };
  const hold = index.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey));
  if (hold?.retryScheduled === false) return { kind: 'unreadable', reason: hold.reason };
  let addressedEpoch: ResolvedStoreEpoch;
  try {
    addressedEpoch = resolveHistoricalAddress(source, epochKey);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : 'Source address cannot be observed' };
  }
  const reader = readers[source.fingerprint];
  const dbPath = addressedEpoch.path;
  if (reader === undefined || observeStorePath(source.storage, dbPath) !== 'present')
    return { kind: 'unreadable', reason: 'Source is absent or its fingerprint is unsupported' };

  let releaseLock: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    const lockPath = join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME);
    if (source.storage.existsSync(lockPath)) {
      const guard = source.storage.lstatSync(lockPath, { bigint: true });
      if (!guard.isFile() || guard.nlink !== 1n) throw new Error('Source lock is malformed.');
    }
    releaseLock = createSharedFileLockSync(lockPath);
    verifyHistoricalIdentity(source, epochKey, addressedEpoch);
    db = source.storage.openSqliteDatabaseSync(dbPath, { readOnly: true });
    db.exec('BEGIN');
    const frontier = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
    const revision = index.revision(epochKey);
    if (jobIds.length === 0 && source.sweep?.revision === revision && source.sweep.frontier === frontier)
      return { kind: 'read' };
    const incremental = jobIds.length === 0 && source.sweep?.revision === revision;
    const requested = new Set(
      source.refreshPending?.jobIds ??
        (jobIds.length
          ? jobIds
          : incremental
            ? db
                .prepare("SELECT DISTINCT stream_id FROM events WHERE stream_kind = 'job' AND seq > ?")
                .all(source.sweep?.frontier ?? 0)
                .map((row) => z.object({ stream_id: z.string() }).parse(row).stream_id)
            : index.locationsFor(epochKey).map((location) => location.jobId)),
    );
    let failed = false;
    for (const jobId of [...requested]) {
      const location = index.read(jobId);
      if (
        location !== null &&
        (!sameEpoch(location.epochKey, epochKey) ||
          (location.disposition === 'terminal' && hasReadableTerminalDetail(location)))
      ) {
        requested.delete(jobId);
        continue;
      }
      if (budget && budget.remaining <= 0) {
        source.refreshPending = { jobIds: [...requested], frontier: source.refreshPending?.frontier ?? frontier };
        return failed
          ? { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' }
          : { kind: 'read' };
      }
      if (budget) budget.remaining--;
      try {
        const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
        if (raw === undefined) {
          requested.delete(jobId);
          continue;
        }
        requested.delete(jobId);
        const row = (source.fingerprint === FINGERPRINT_0110 ? newerProjectionSchema : olderProjectionSchema).parse(
          raw,
        );
        const appended = readEvents(db, row.job_id, source.sweep?.frontier ?? 0);
        if (source.sweep && appended.length === 0 && !isTerminalPhase(row.phase)) continue;
        const events =
          isTerminalPhase(row.phase) || appended.some((event) => event.type === 'job.terminal.recorded')
            ? readEvents(db, row.job_id)
            : appended;
        const detail = historicalDetail(
          db,
          {
            ...row,
            work_dir: canonicalWorkDirWireSchema
              .nullable()
              .parse(row.work_dir ?? location?.subject.workDir ?? row.project_root),
          },
          events,
        );
        if (location === null) {
          index.register(jobId, epochKey, {
            projectRoot: detail.status.projectRoot,
            workDir: detail.status.workDir,
            jobKind: detail.status.jobKind,
          });
          index.markUnresolved(jobId);
        }
        const terminal = [...detail.events].reverse().find((event) => event.type === 'terminal');
        if (!isTerminalPhase(detail.status.phase) || detail.exit === null || terminal === undefined) {
          index.recordObserved(row.job_id, detail);
          continue;
        }
        const resultPath = resultPathFor(source.jobsRoot, row.job_id);
        try {
          index.recordTerminal(row.job_id, detail, resultPath, terminal.seq, db as Database);
        } catch {
          failed = true;
          requested.add(jobId);
          index.resultRepairFailures.add(row.job_id);
        }
        try {
          index
            .resultExportOwnerForSource(db as Database, epochKey, source.jobsRoot)
            .ensureResultMarkdownArtifact(row.job_id);
        } catch {
          /* Failed publication must not hide a retained terminal. */
        }
      } catch {
        failed = true;
        requested.add(jobId);
      }
    }
    if (failed) return { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' };
    for (const jobId of requested) {
      if (readEvents(db, jobId).some((event) => event.type === 'job.terminal.recorded'))
        return { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' };
    }
    const highWaterSeq = z
      .object({ seq: z.number().int().nonnegative() })
      .parse(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'").get()).seq;
    index.clearUnknownLocations(epochKey);
    index.certify(epochKey, highWaterSeq);
    source.sweep = { revision: index.revision(epochKey), frontier: source.refreshPending?.frontier ?? frontier };
    source.refreshPending = undefined;
    return { kind: 'read' };
  } catch (error) {
    // An unreadable refresh cannot certify absence or void an earlier terminal certificate.
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : 'Historical source cannot be read' };
  } finally {
    db?.close();
    releaseLock?.();
  }
}
