import { backendLog } from '../infra/backend-log.js';
import {
  epochHoldDirectory,
  epochIdentity,
  epochToken,
  sameEpoch,
  sameEpochOrFallbackAddress,
} from '../store/epoch/identity.js';
import { setImmediate } from 'node:timers/promises';
import { hasReadableTerminalDetail } from './terminal/identity.js';
import {
  HistoricalDecodeError,
  isCodeDefect,
  sourceReadFailureDisposition,
  sourceReadStamp,
  type SourceReadDisposition,
} from './source-read.js';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireSharedFileLockNoRepairSync, createSharedFileLockSync } from '../infra/fs-lock.js';
import type { SqliteDatabasePort, SqliteStatementPort, StoragePort } from '../infra/port-types.js';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { Runtime } from '../runtime/ports.js';
import { type StoreEpochListEntry, STORE_LOCK_FILE_NAME, type ResolvedStoreEpoch } from '../store/epoch/index.js';
import {
  observeProtectedEpoch,
  observeResolvedStoreEpoch,
  inspectResolvedStoreEpochKey,
} from '../store/epoch/index.js';
import { inspectEpochKey } from '../store/epoch/key.js';
import { SQLITE_BUSY_ERRCODE } from '../store/epoch/constants.js';
import {
  type JobLocationIndex,
  type JobLocationSubject,
  type JobLocationView,
  type JobLocation,
} from './location-index.js';
import { ensureSentence } from '../infra/text.js';
import { phaseForOutcome } from './outcome.js';
import { type UsageSummary } from '../providers/contract.js';
import { writeResultArtifact, type DecodedResultArtifact } from './terminal/artifact.js';
import { jobRetentionCutoff } from './export-retention.js';
import { currentResultInput, loadRetainedCurrentJob, retainCurrentJob } from './retained-current.js';
import type { Database } from '../store/db.js';
import { observeStorePath } from '../store/path-observation.js';
import { type JobDetailResponse, type JobDiagnostics, type JobEvent, type JobStatus } from './records.js';
import { isTerminalPhase } from './phase.js';

const FINGERPRINT_0100 = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const FINGERPRINT_0105 = 'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980';
const FINGERPRINT_0110 = 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521';

const historicalWorkDirSchema = z
  .string()
  .refine((value) => isAbsolute(value) && normalize(value) === value && resolve(value) === value)
  .brand<'CanonicalWorkDir'>();
const historicalOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider-session'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('discussion'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('system-task'), id: z.string().min(1) }).strict(),
]);
const historicalProgressTimingSchema = z
  .object({
    origin: z.enum(['runtime', 'queued', 'launch']),
    originAt: z.string(),
    emittedAt: z.string(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();
const historicalJobKindSchema = z.enum(['provider', 'workflow', 'kb']);

const historicalPhaseSchema = z.enum(['queued', 'launching', 'running', 'completed', 'error', 'aborted']);
const historicalCauseSchema = z
  .object({
    stream: z.object({ kind: z.enum(['job', 'session', 'discuss', 'workflow']), id: z.string().min(1) }).strict(),
    seq: z.number().int().positive(),
  })
  .strict();
const historicalErrorSchema = z.object({ message: z.string(), stack: z.string().optional() }).strict();
const historicalUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().optional(),
    jobsWithoutCostData: z.number().int().nonnegative().optional(),
  })
  .strict();
const historicalProgressFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing_launch_record') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: historicalErrorSchema }).strict(),
]);
const historicalDiagnosticsSchema = z
  .object({
    progressFaults: z.array(historicalProgressFaultSchema),
    warnings: z.array(z.string()).optional(),
    usage: historicalUsageSchema.optional(),
    processExit: z.object({ exitCode: z.number().nullable(), signal: z.string().nullable() }).strict().optional(),
    byteCounts: z.object({ stdout: z.number(), stderr: z.number() }).strict().optional(),
  })
  .strict();
const historicalTerminalSchema = z
  .object({
    content: z.string(),
    durationMs: z.number().nonnegative(),
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('completed') }).strict(),
      z
        .object({ kind: z.literal('aborted'), reason: z.enum(['signal_abort', 'user_abort', 'queue_shutdown']) })
        .strict(),
      z.object({ kind: z.literal('provider_exit'), code: z.number(), note: z.string().optional() }).strict(),
      z.object({ kind: z.literal('failed'), causeRef: historicalCauseSchema }).strict(),
      z
        .object({
          kind: z.literal('job_fault'),
          fault: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('ghost_launch') }).strict(),
            z.object({ kind: z.literal('wrapper_lost') }).strict(),
            z.object({ kind: z.literal('wrapper_crashed'), cause: historicalErrorSchema }).strict(),
            z
              .object({
                kind: z.literal('provider_binding'),
                provider: z.string(),
                reason: z.enum([
                  'missing-profile',
                  'profile-unavailable',
                  'identity-unavailable',
                  'profile-mismatch',
                  'subject-mismatch',
                  'unsupported-selection',
                  'invalid-persisted-binding',
                ]),
                message: z.string(),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();

function historicalResultPath(jobsRoot: string, jobId: string): string {
  return join(jobsRoot, jobId, 'result.md');
}

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
const historicalEnvelopeSchema = eventSchema.extend({
  stream_kind: z.enum(['job', 'session', 'discuss', 'workflow']),
  stream_id: z.string().min(1),
  namespace: z.string().nullable().optional().default(null),
  project: z.string().nullable().optional().default(null),
  correlation_id: z.string().nullable().optional().default(null),
  causation_seq: z.number().nullable().optional().default(null),
  refs: z.string().nullable().optional().default(null),
});
const terminalBodySchema = z
  .object({
    terminal: historicalTerminalSchema,
    diagnostics: z.object({}).passthrough().optional(),
  })
  .passthrough();
const progressBodySchema = z
  .object({
    kind: z.literal('message'),
    message: z.string(),
    timing: historicalProgressTimingSchema,
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
type HistoricalDatabase = { prepare(sql: string): Pick<SqliteStatementPort, 'get' | 'all'> };
type HistoricalReadFrontier = {
  frontier: number;
  location: JobLocation | null;
  absent?: boolean;
  /** The job's own projection `last_seq` at the read; its location holds only while that is unchanged. */
  jobSeq?: number;
};
type HistoricalReadCache = {
  jobs: Map<string, HistoricalReadFrontier>;
  /** The source stamp and frontier of this session's last opened read; it vouches only for answers taken there. */
  observed?: { path: string; stamp: string; frontier: number };
};

type HistoricalEpochSource = {
  readonly epochKey: string;
  readonly runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>;
  readonly originalEpoch: ResolvedStoreEpoch;
  readonly fingerprint: string;
  readonly jobsRoot: string;
  readonly storage: StoragePort;
  attempts: number;
  refreshAttempts: number;
  readCache?: WeakMap<object, HistoricalReadCache>;
  sweep?: { revision: number; frontier: number };
  retired?: boolean;
  refreshPending?: { jobIds: string[]; frontier: number };
  seed?: {
    frontier?: number;
    /** Launched jobs in launch order, then projected jobs without a launch: read once, so no slice reads them again. */
    subjects?: readonly string[];
    launchSeqs?: ReadonlyMap<string, number>;
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
  if (!location || hasReadableTerminalDetail(location)) return;
  // Only a registered source hydrates, and it owns its hold under its own key, so no other hold needs to be read here.
  if (!historicalSources.get(index)?.has(epochIdentity(location.epochKey))) return;
  if (index.ownsUnknownLocationHold(location.epochKey)) return;
  hydrationListeners.get(index)?.(location.epochKey);
}

/** The registered, unretired source whose epoch owns this hold directory; only it can retry that hold. */
export function registeredHistoricalEpoch(view: JobLocationView, directory: string): string | undefined {
  for (const source of historicalSources.get(view)?.values() ?? [])
    if (!source.retired && epochHoldDirectory(source.epochKey) === directory) return source.epochKey;
  return undefined;
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
type RetainedLocation = Readonly<{ kind: 'read'; location: JobLocation | null }> | Readonly<{ kind: 'unreadable' }>;

/** A retained location this build cannot read is uncertainty about that one job; it never holds the epoch's others. */
function readRetainedLocation(index: JobLocationIndex, jobId: string): RetainedLocation {
  try {
    return { kind: 'read', location: index.read(jobId) };
  } catch (error) {
    if (isCodeDefect(error)) throw error;
    return { kind: 'unreadable' };
  }
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
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
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

interface RetainedSourceReader {
  readonly openedEventType: 'job.opened' | 'job.launch.requested';
  readonly terminalIsImmutable: boolean;
  resultInput(input: {
    index: JobLocationIndex;
    epochKey: string;
    db: Database;
    jobId: string;
    execution?: number;
  }): DecodedResultArtifact | null;
  prepare(input: {
    index: JobLocationIndex;
    source?: HistoricalEpochSource;
    db: Database;
    epochKey: string;
    jobId: string;
    jobsRoot: string;
    runtime: Runtime;
  }): void;
  repair: typeof repairHistoricalResult;
  hydrateSeed(input: {
    index: JobLocationIndex;
    db: HistoricalDatabase;
    epochKey: string;
    jobId: string;
    launchSeq?: number;
    knownJobs: readonly KnownHistoricalJob[];
    fingerprint: string;
    jobsRoot: string;
    observed: Set<string>;
  }): void;
  readLocation(
    db: HistoricalDatabase,
    source: HistoricalEpochSource,
    epochKey: string,
    jobId: string,
    raw: unknown,
    fullHistory: boolean,
  ): { location: JobLocation | null; absent: boolean; jobSeq?: number };
  refresh(input: {
    index: JobLocationIndex;
    source: HistoricalEpochSource;
    db: HistoricalDatabase;
    epochKey: string;
    jobId: string;
    location: JobLocation | null;
    raw: unknown;
    requested: Set<string>;
  }): boolean;
  pendingIsUnreadable(db: HistoricalDatabase, jobId: string): boolean;
}

function retainedSourceReader(index: JobLocationView, fingerprint: string): RetainedSourceReader | undefined {
  if (fingerprint === index.currentFingerprint) return currentSourceReader;
  if ([FINGERPRINT_0100, FINGERPRINT_0105, FINGERPRINT_0110].includes(fingerprint)) return frozenSourceReader;
  return undefined;
}

function requireRetainedSourceReader(index: JobLocationView, fingerprint: string): RetainedSourceReader {
  const reader = retainedSourceReader(index, fingerprint);
  if (reader === undefined) throw new HistoricalDecodeError('Retained source format is unknown');
  return reader;
}

function readEvents(db: HistoricalDatabase, jobId: string, afterSeq = 0): z.infer<typeof eventSchema>[] {
  return db
    .prepare(
      "SELECT seq, ts, type, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND seq > ? AND type IN ('job.launch.requested', 'job.progress.emitted', 'job.runtime.started', 'job.terminal.recorded') ORDER BY seq ASC",
    )
    .all(jobId, afterSeq)
    .map((row) => eventSchema.parse(row));
}

function readMetadata(db: HistoricalDatabase, jobId: string): z.infer<typeof eventSchema>[] {
  return db
    .prepare(
      "SELECT seq, ts, type, body FROM events WHERE seq IN (SELECT MAX(seq) FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type IN ('job.launch.requested', 'job.runtime.started', 'job.terminal.recorded') GROUP BY type) ORDER BY seq ASC",
    )
    .all(jobId)
    .map((row) => eventSchema.parse(row));
}

function parseBody(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

function diagnosticsFrom(raw: string): JobDiagnostics {
  return historicalDiagnosticsSchema.parse(JSON.parse(raw) as unknown);
}

function historicalProgressFaults(row: Projection, events: readonly z.infer<typeof eventSchema>[]) {
  const recorded = events
    .filter((event) => event.type === 'job.progress.emitted')
    .map((event) => historicalProgressFaultSchema.safeParse(parseBody(event.body)))
    .flatMap((fault) => (fault.success ? [fault.data] : []));
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
  db: HistoricalDatabase,
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
  const jobKind = historicalJobKindSchema.parse(row.job_kind);
  const workDir =
    jobKind === 'kb'
      ? null
      : historicalWorkDirSchema.parse(
          row.work_dir ?? (launchBody?.success ? launchBody.data.request.cwd : row.project_root),
        );

  const terminalEvent = [...events].reverse().find((event) => event.type === 'job.terminal.recorded');
  const terminalBody = terminalEvent === undefined ? null : terminalBodySchema.parse(parseBody(terminalEvent.body));
  const phase =
    terminalBody === null ? historicalPhaseSchema.parse(row.phase) : phaseForOutcome(terminalBody.terminal.outcome);
  const status: JobStatus = {
    jobId: row.job_id,
    owner: historicalOwnerSchema.parse(JSON.parse(row.execution_owner) as unknown),
    sessionId: row.session_id,
    execution: 1,
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
          ...historicalDiagnosticsSchema.omit({ progressFaults: true }).parse(terminalBody.diagnostics ?? {}),
        };
  if (jobKind === 'workflow') {
    const usage = historicalWorkflowUsage(db, row.job_id);
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
        ...{ sessionId: row.session_id },
        seq: event.seq,
        ts: event.ts,
        message: progress.data.message,
        timing: progress.data.timing,
      });
    } else if (event.type === 'job.terminal.recorded' && terminalBody !== null) {
      renderedEvents.push({
        type: 'terminal',
        jobId: row.job_id,
        ...{ sessionId: row.session_id },
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
    executionAddressing: 'lifetime',
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

function historicalWorkflowUsage(db: HistoricalDatabase, workflowJobId: string): UsageSummary | undefined {
  const rows = db
    .prepare('SELECT diagnostics FROM projection_jobs WHERE parent_workflow_job_id = ? ORDER BY job_id ASC')
    .all(workflowJobId);
  const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
  const result: UsageSummary = {};
  let sawUsage = false;
  let sawCost = false;
  let missing = 0;
  for (const raw of rows) {
    const row = z.object({ diagnostics: z.string() }).parse(raw);
    const usage = diagnosticsFrom(row.diagnostics).usage;
    if (usage === undefined || (!fields.some((field) => usage[field] !== undefined) && usage.costUsd === undefined))
      continue;
    sawUsage = true;
    for (const field of fields) if (usage[field] !== undefined) result[field] = (result[field] ?? 0) + usage[field];
    if (usage.costUsd === undefined) missing++;
    else {
      result.costUsd = (result.costUsd ?? 0) + usage.costUsd;
      sawCost = true;
    }
  }
  if (!sawUsage) return undefined;
  if (!sawCost) delete result.costUsd;
  if (missing > 0) result.jobsWithoutCostData = missing;
  return result;
}

function historicalTerminalDescription(terminal: z.infer<typeof historicalTerminalSchema>): string {
  const outcome = terminal.outcome;
  switch (outcome.kind) {
    case 'completed':
      return 'Completed.';
    case 'aborted':
      return `Aborted: ${outcome.reason}.`;
    case 'provider_exit':
      return outcome.note === undefined
        ? `Provider exited ${outcome.code}.`
        : `Provider exited ${outcome.code}: ${ensureSentence(outcome.note)}`;
    case 'failed':
      return `Failed: ${outcome.causeRef.stream.kind}/${outcome.causeRef.stream.id}#${outcome.causeRef.seq}`;
    case 'job_fault': {
      const fault = outcome.fault;
      switch (fault.kind) {
        case 'ghost_launch':
          return 'Launch recorded but no provider process was observed.';
        case 'wrapper_lost':
          return 'Provider wrapper exited without reporting an outcome.';
        case 'wrapper_crashed':
          return `Provider wrapper crashed: ${fault.cause.message}.${fault.cause.stack ? `\n${fault.cause.stack}` : ''}`;
        case 'provider_binding':
          return `Provider binding ${fault.reason}: ${ensureSentence(fault.message)}`;
      }
    }
  }
}

function historicalCauseDescription(
  db: HistoricalDatabase,
  ref: z.infer<typeof historicalCauseSchema>,
  visited = new Set<number>(),
): string | null {
  if (visited.has(ref.seq)) return null;
  visited.add(ref.seq);
  const raw = db
    .prepare('SELECT * FROM events WHERE seq = ? AND stream_kind = ? AND stream_id = ?')
    .get(ref.seq, ref.stream.kind, ref.stream.id);
  if (raw === undefined) return null;
  const event = historicalEnvelopeSchema.parse(raw);
  const body = z.object({}).passthrough().parse(parseBody(event.body));
  let local = event.type;
  if (event.type === 'workflow.completed' && typeof body.outcome === 'string') local = `Workflow ${body.outcome}.`;
  if (event.type === 'workflow.lifecycle_fault' && typeof body.kind === 'string' && typeof body.message === 'string')
    local = `Workflow lifecycle fault (${body.kind}): ${body.message}.`;
  if (event.type === 'job.terminal.recorded') {
    const terminal = terminalBodySchema.safeParse(body);
    if (terminal.success) local = historicalTerminalDescription(terminal.data.terminal);
  }
  const nested = z.object({ kind: z.literal('failed'), causeRef: historicalCauseSchema });
  const direct = historicalCauseSchema.safeParse(body.causeRef);
  const reason = nested.safeParse(body.reason);
  const terminal = z.object({ outcome: nested }).safeParse(body.terminal);
  const next = direct.success
    ? direct.data
    : reason.success
      ? reason.data.causeRef
      : terminal.success
        ? terminal.data.outcome.causeRef
        : undefined;
  if (next === undefined) return local;
  const description = historicalCauseDescription(db, next, visited);
  return description === null ? null : `${local} Caused by: ${description}`;
}

function historicalWorkflowMarkdown(
  db: HistoricalDatabase,
  jobId: string,
  accepted: z.infer<typeof historicalEnvelopeSchema>,
  terminal: z.infer<typeof historicalTerminalSchema>,
): string | null {
  const completed = db
    .prepare(
      "SELECT * FROM events WHERE stream_kind = 'workflow' AND stream_id = ? AND type = 'workflow.completed' AND seq < ? ORDER BY seq DESC LIMIT 1",
    )
    .get(jobId, accepted.seq);
  if (completed === undefined) return `${historicalTerminalDescription(terminal)}\n`;
  const steps = z.array(
    z
      .object({
        stepIndex: z.number().int().nonnegative(),
        atomIndex: z.number().int().nonnegative(),
        label: z.string(),
        output: z.string(),
      })
      .strict(),
  );
  const parsed = z
    .discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('completed'), stepDetails: steps }).strict(),
      z.object({ outcome: z.literal('aborted'), stepDetails: steps }).strict(),
      z
        .object({
          outcome: z.literal('failed'),
          stepDetails: steps,
          causeRef: historicalCauseSchema,
          failureLocation: z
            .object({
              slotId: z.string().optional(),
              stepIndex: z.number().int().nonnegative().optional(),
              atomLabel: z.string().optional(),
              jobId: z.string().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ])
    .safeParse(parseBody(historicalEnvelopeSchema.parse(completed).body));
  if (!parsed.success || parsed.data.outcome !== terminal.outcome.kind) return null;
  if (
    terminal.outcome.kind === 'failed' &&
    (terminal.outcome.causeRef.stream.kind !== 'workflow' ||
      terminal.outcome.causeRef.stream.id !== jobId ||
      terminal.outcome.causeRef.seq !== historicalEnvelopeSchema.parse(completed).seq)
  )
    return null;
  const markdown = parsed.data.stepDetails
    .flatMap((step) => [
      `# Step ${step.stepIndex}.${step.atomIndex}: ${step.label}`,
      '',
      ...step.output.split('\n'),
      '',
    ])
    .join('\n');
  return markdown.trim().length > 0 ? markdown : `${historicalTerminalDescription(terminal)}\n`;
}

function historicalResultInput(db: HistoricalDatabase, jobId: string): DecodedResultArtifact | null {
  const raw = db
    .prepare(
      "SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.terminal.recorded' ORDER BY seq DESC LIMIT 1",
    )
    .get(jobId);
  if (raw === undefined) return null;
  const accepted = historicalEnvelopeSchema.parse(raw);
  const body = terminalBodySchema.parse(parseBody(accepted.body));
  const preceding = z
    .object({ ts: z.string() })
    .optional()
    .parse(
      db
        .prepare(
          "SELECT ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1",
        )
        .get(jobId, accepted.seq),
    );
  const at = Date.parse(accepted.ts);
  const before = preceding === undefined ? at : Date.parse(preceding.ts);
  const age = !Number.isFinite(at) || !Number.isFinite(before) ? 'unknown' : at < before ? 'regression' : at;
  const outcome = body.terminal.outcome;
  const fallback =
    outcome.kind === 'failed'
      ? `Failed: ${historicalCauseDescription(db, outcome.causeRef) ?? `${outcome.causeRef.stream.kind}/${outcome.causeRef.stream.id}#${outcome.causeRef.seq}`}`
      : historicalTerminalDescription(body.terminal);
  const launch = db
    .prepare(
      "SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested' ORDER BY seq LIMIT 1",
    )
    .get(jobId);
  let identity = '';
  if (launch !== undefined) {
    const event = historicalEnvelopeSchema.parse(launch);
    const refs = z
      .object({ parentJobId: z.string(), workflowSlotId: z.string().optional() })
      .passthrough()
      .safeParse(event.refs === null ? null : JSON.parse(event.refs));
    const launchBody = launchBodySchema.parse(parseBody(event.body));
    if (launchBody.jobKind === 'workflow')
      return {
        accepted,
        terminal: body.terminal,
        age,
        markdown: historicalWorkflowMarkdown(db, jobId, accepted, body.terminal),
      };
    const metadata = z
      .object({ workflowSlotGeneration: z.number().optional(), replacesWorkflowJobId: z.string().optional() })
      .passthrough()
      .parse(parseBody(event.body));
    if (refs.success) {
      const lines = [
        `> Parent workflow: ${refs.data.parentJobId}`,
        `> Workflow slot: ${refs.data.workflowSlotId}`,
        `> Workflow generation: ${metadata.workflowSlotGeneration}`,
      ];
      if (metadata.replacesWorkflowJobId !== undefined)
        lines.push(`> Replaces workflow job: ${metadata.replacesWorkflowJobId}`);
      identity = `${lines.join('\n')}\n\n`;
    }
  }
  return {
    accepted,
    terminal: body.terminal,
    age,
    markdown: `${identity}${body.terminal.content.trimEnd() || fallback}\n`,
  };
}

/** Unknown retained formats cannot fall through to the live terminal decoder. */
export function retainedResultInput(
  index: JobLocationIndex,
  epochKey: string,
  db: Database,
  jobId: string,
  execution?: number,
): DecodedResultArtifact | null {
  const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
  const fingerprint =
    source?.fingerprint ??
    z
      .object({ value: z.string() })
      .optional()
      .parse(db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get())?.value;
  if (fingerprint === undefined) throw new HistoricalDecodeError('Retained source has no readable format fingerprint');
  return requireRetainedSourceReader(index, fingerprint).resultInput({ index, epochKey, db, jobId, execution });
}

export function prepareRetainedJob(
  index: JobLocationIndex,
  db: Database,
  epochKey: string,
  jobId: string,
  jobsRoot: string,
  runtime: Runtime,
): void {
  const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
  const fingerprint =
    source?.fingerprint ??
    z
      .object({ value: z.string() })
      .optional()
      .parse(db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get())?.value;
  if (fingerprint === undefined) return;
  retainedSourceReader(index, fingerprint)?.prepare({ index, source, db, epochKey, jobId, jobsRoot, runtime });
}

function prepareFrozenJob({ index, source, db, jobId }: Parameters<RetainedSourceReader['prepare']>[0]): void {
  if (source === undefined) return;
  const detail = readHistoricalJobDetail(db, jobId);
  const terminal = detail?.events.find((event) => event.type === 'terminal');
  if (detail?.exit === null || detail === null || terminal === undefined) return;
  index.recordTerminal(jobId, detail, historicalResultPath(source.jobsRoot, jobId), terminal.seq);
}

function repairHistoricalResult(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  jobId: string,
): void {
  const location = index.read(jobId);
  if (!location || !sameEpoch(location.epochKey, source.epochKey) || !hasReadableTerminalDetail(location)) return;
  const input = historicalResultInput(db, jobId);
  if (
    input === null ||
    input.markdown === null ||
    location.terminalSeq !== input.accepted.seq ||
    location.detail.kind !== 'recorded' ||
    !isDeepStrictEqual(location.detail.value.status.result, input.terminal)
  )
    return;
  const target = historicalResultPath(source.jobsRoot, jobId);
  try {
    const stat = source.storage.lstatSync(target, { bigint: true });
    if (stat.isFile() && stat.size > 0n) return;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    /* Missing exports can be repaired only from this guarded source. */
  }
  const authorized = (): boolean => {
    verifyHistoricalIdentity(source, source.epochKey, resolveHistoricalAddress(source, source.epochKey));
    if (!sameEpoch(index.read(jobId)?.epochKey, source.epochKey)) return false;
    return (
      typeof input.age !== 'number' || input.age >= jobRetentionCutoff({ time: index.time, env: source.runtime.env })
    );
  };
  writeResultArtifact(source.storage, target, input.markdown, authorized, source.jobsRoot);
}

function repairRetainedResult(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  jobId: string,
): void {
  requireRetainedSourceReader(index, source.fingerprint).repair(index, source, db, jobId);
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
      const fallbackKey = JSON.stringify({ storeRoot: resolved.storeRoot, epoch: resolved.epoch, path: resolved.path });
      if (fallbackKey !== key && index.ownsUnknownLocationHold(fallbackKey)) index.clearUnknownLocations(fallbackKey);
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
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
      const count = (attempts.get(address) ?? 0) + 1;
      attempts.set(address, count);
      const retrying = count < 3;
      const reason = retrying
        ? `Source identity unreadable; epoch maintenance retries every 5 s and settles after 3 consecutive failures (attempt ${count} of 3)`
        : 'Source identity unreadable; epoch maintenance settled after 3 consecutive failures; re-read at next start';
      try {
        index.holdUnknownLocations(fallback, reason, retrying);
        // A hold an earlier owner wrote under this address's full key has no owner while only the address registers,
        // so it follows the address's own retry and settlement instead of promising a retry nobody runs.
        for (const hold of index.unknownLocationHolds())
          if (
            hold.epochKey !== undefined &&
            hold.epochKey !== fallback &&
            sameEpochOrFallbackAddress(fallback, hold.epochKey) &&
            !historicalSources.get(index)?.has(epochIdentity(hold.epochKey)) &&
            hold.retryScheduled !== retrying
          )
            index.holdUnknownLocations(hold.epochKey, reason, retrying);
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
        /* An unobservable entry must not stop registration of other epochs. */
      }
    }
  }
}

interface HistoricalSeedContext {
  index: JobLocationIndex;
  source: HistoricalEpochSource;
  seed: NonNullable<HistoricalEpochSource['seed']>;
  epochKey: string;
  fingerprint: string;
  jobsRoot: string;
  storage: StoragePort;
  knownJobs: readonly KnownHistoricalJob[];
  certifyRetiredEpoch: boolean;
  budget?: { remaining: number };
}

interface HistoricalSeedResources {
  db: SqliteDatabasePort | null;
  releaseLock: (() => void) | null;
}

function settleHistoricalSeedFailure(
  { index, source, epochKey }: HistoricalSeedContext,
  error: unknown,
  addressFailure?: 'protected-epoch-address-unreadable',
): HistoricalSeedResult {
  holdSourceFailure(index, epochKey, error, source.attempts, addressFailure === undefined);
  for (const location of index.locationsFor(epochKey))
    if (!hasReadableTerminalDetail(location)) index.markUnresolved(location.jobId);
  return {
    kind: 'unrecoverable-retained',
    knownJobIds: index.locationsFor(epochKey).map((location) => location.jobId),
    reason: addressFailure ?? index.unknownLocationHold(epochKey) ?? 'retained-store-unreadable',
  };
}

function openHistoricalSeedSource(
  context: HistoricalSeedContext,
  addressedEpoch: ResolvedStoreEpoch,
  resources: HistoricalSeedResources,
): { db: SqliteDatabasePort; frontier: number } {
  const { source, seed, epochKey } = context;
  const { storage } = context;
  const lockPath = join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME);
  if (storage.existsSync(lockPath)) {
    const guard = storage.lstatSync(lockPath, { bigint: true });
    if (!guard.isFile() || guard.nlink !== 1n) throw new Error('Source lock is malformed.');
  }
  resources.releaseLock = createSharedFileLockSync(lockPath);
  verifyHistoricalIdentity(source, epochKey, addressedEpoch);
  const db = storage.openSqliteDatabaseSync(addressedEpoch.path, { readOnly: true });
  resources.db = db;
  db.exec('BEGIN');
  seed.frontier ??= (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  return { db, frontier: seed.frontier };
}

function repairHistoricalSeedResult(context: HistoricalSeedContext, db: SqliteDatabasePort, jobId: string): void {
  const { index, source, fingerprint, jobsRoot, storage } = context;
  if (
    !requireRetainedSourceReader(index, fingerprint).terminalIsImmutable ||
    !storage.existsSync(historicalResultPath(jobsRoot, jobId))
  ) {
    try {
      repairRetainedResult(index, source, db, jobId);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
      /* Publication failure cannot hide the retained outcome. */
    }
  }
}

function observeHistoricalSeedRow(
  context: HistoricalSeedContext,
  db: SqliteDatabasePort,
  jobId: string,
): 'unreadable' | 'retained' | 'hydrate' {
  const { index, epochKey } = context;
  const retainedRead = readRetainedLocation(index, jobId);
  if (retainedRead.kind === 'unreadable') return 'unreadable';
  const retained = retainedRead.location;
  if (retained && sameEpoch(retained.epochKey, epochKey) && hasReadableTerminalDetail(retained)) {
    repairHistoricalSeedResult(context, db, jobId);
    return 'retained';
  }
  return 'hydrate';
}

function recordHistoricalSeedRowFailure(
  context: HistoricalSeedContext,
  jobId: string,
  offset: number,
  error: unknown,
): void {
  const { index, seed } = context;
  seed.recordingError ??= error instanceof Error ? error : new Error(String(error));
  seed.failedRowOffset ??= offset;
  try {
    index.markUnresolved(jobId);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    // A subject whose location cannot be marked is covered by the epoch hold; it must not stop later subjects.
  }
  index.resultRepairFailures.add(jobId);
}

function hydrateHistoricalSeedRow(
  context: HistoricalSeedContext,
  db: SqliteDatabasePort,
  { jobId, launchSeq, offset }: { jobId: string; launchSeq: number | undefined; offset: number },
  observed: Set<string>,
): void {
  const { index, seed, epochKey, knownJobs } = context;
  const { fingerprint, jobsRoot } = context;
  const retained = observeHistoricalSeedRow(context, db, jobId);
  if (retained !== 'hydrate') {
    if (retained === 'retained') observed.add(jobId);
    seed.rowOffset = offset + 1;
    return;
  }
  try {
    hydrateHistoricalSeedJob(index, db, epochKey, jobId, launchSeq, knownJobs, fingerprint, jobsRoot, observed);
  } catch (error) {
    recordHistoricalSeedRowFailure(context, jobId, offset, error);
  } finally {
    seed.rowOffset = offset + 1;
  }
}

function hydrateHistoricalSeedRows(
  context: HistoricalSeedContext,
  db: SqliteDatabasePort,
  frontier: number,
): HistoricalSeedResult {
  const { index, source, seed, epochKey, knownJobs, certifyRetiredEpoch, budget } = context;
  const observed = new Set<string>();
  const {
    subjects: sourceSubjects,
    launchSeqs,
    members,
  } = historicalSeedSubjects(index, seed, db, context.fingerprint);
  const pending = (): HistoricalSeedResult => {
    source.attempts = 0;
    index.holdUnknownLocations(
      epochKey,
      'Historical hydration is pending; epoch maintenance continues it every 5 s',
      true,
    );
    return { kind: 'uncertified', knownJobIds: [...observed] };
  };
  const knownOnly = [...new Set(knownJobs.map((job) => job.jobId))].filter((jobId) => !members.has(jobId));
  const subjectCount = sourceSubjects.length + knownOnly.length;
  const subjectAt = (i: number): string =>
    i < sourceSubjects.length ? sourceSubjects[i] : knownOnly[i - sourceSubjects.length];
  for (let i = seed.rowOffset; i < subjectCount; i++) {
    const jobId = subjectAt(i);
    if (budget) {
      if (budget.remaining <= 0) return pending();
      budget.remaining--;
    }
    hydrateHistoricalSeedRow(context, db, { jobId, launchSeq: launchSeqs.get(jobId), offset: i }, observed);
  }
  for (let i = 0; i < subjectCount; i++) observed.add(subjectAt(i));
  if (seed.recordingError !== undefined) {
    if (seed.failedRowOffset !== undefined) seed.rowOffset = seed.failedRowOffset;
    source.attempts = (seed.failures ?? 0) + 1;
    seed.failures = source.attempts;
    const error = seed.recordingError;
    seed.recordingError = undefined;
    seed.failedRowOffset = undefined;
    throw error;
  }
  return completeHistoricalSeed(index, source, frontier, db, epochKey, observed, certifyRetiredEpoch);
}

function historicalSeedUnavailable(
  context: HistoricalSeedContext,
  addressedEpoch: ResolvedStoreEpoch,
  reader: ReturnType<typeof retainedSourceReader>,
): HistoricalSeedResult | null {
  const { index, source, epochKey, knownJobs, fingerprint, budget } = context;
  if (observeHistoricalPath(source, epochKey, addressedEpoch) === 'absent') {
    registerKnownHistoricalJobs(index, epochKey, knownJobs, budget);
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
  return null;
}

function runHistoricalSeed(context: HistoricalSeedContext): HistoricalSeedResult {
  const { index, source, epochKey, knownJobs, budget } = context;
  const { fingerprint } = context;
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
    registerKnownHistoricalJobs(index, epochKey, knownJobs, budget);
    return settleHistoricalSeedFailure(context, error, 'protected-epoch-address-unreadable');
  }
  const reader = retainedSourceReader(index, fingerprint);
  const resources: HistoricalSeedResources = { db: null, releaseLock: null };
  try {
    const unavailable = historicalSeedUnavailable(context, addressedEpoch, reader);
    if (unavailable !== null) return unavailable;
    const { db, frontier } = openHistoricalSeedSource(context, addressedEpoch, resources);
    return hydrateHistoricalSeedRows(context, db, frontier);
  } catch (error: unknown) {
    return settleHistoricalSeedFailure(context, error);
  } finally {
    resources.db?.close();
    resources.releaseLock?.();
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
  return runHistoricalSeed({
    index,
    source,
    seed,
    epochKey,
    fingerprint,
    jobsRoot,
    storage,
    knownJobs,
    certifyRetiredEpoch,
    budget,
  });
}

export function readHistoricalJobDetail(db: HistoricalDatabase, jobId: string): JobDetailResponse | null {
  const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
  if (raw === undefined) return null;
  return historicalDetail(db, olderProjectionSchema.parse(raw), readEvents(db, jobId));
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
  fullHistory?: boolean,
) => HistoricalSourceRead;

/** Source observation cannot hydrate locations, publish artifacts, or repair the guard. */
export function readHistoricalSource(
  view: JobLocationView,
  epochKey: string,
  jobIds: readonly string[],
  session?: object,
  fullHistory = false,
): HistoricalSourceRead {
  const source = historicalSources.get(view)?.get(epochIdentity(epochKey));
  if (source === undefined) {
    return unregisteredHistoricalRead(view, epochKey);
  }
  if (source.retired) return { kind: 'unreadable', disposition: 'retired', retired: true };
  const settledHold = view
    .unknownLocationHolds()
    .find((hold) => sameEpoch(hold.epochKey, epochKey) && !hold.retryScheduled);
  if (settledHold !== undefined)
    return { kind: 'unreadable', disposition: 'settled-unreadable', reason: settledHold.reason };
  if (retainedSourceReader(view, source.fingerprint) === undefined)
    return {
      kind: 'unreadable',
      disposition: 'settled-unreadable',
      reason:
        'This build cannot read the retained source format; epoch maintenance re-reads it at the next coordinator start',
    };
  const cached = readVouchedHistoricalCache(source, jobIds, session, fullHistory);
  if (cached !== null) return cached;
  let release: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    const epoch = resolveHistoricalAddress(source, epochKey);
    if (observeHistoricalPath(source, epochKey, epoch) === 'absent')
      return { kind: 'unreadable', disposition: 'retired', retired: true };
    release = acquireSharedFileLockNoRepairSync(join(dirname(epoch.path), STORE_LOCK_FILE_NAME));
    verifyHistoricalIdentity(source, epochKey, epoch);
    const stamp = sourceReadStamp(source.storage, epoch.path);
    db = source.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true });
    db.exec('BEGIN');
    const frontier = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
    if (session) source.readCache ??= new WeakMap();
    const readCache = (session ? source.readCache?.get(session) : undefined) ?? {
      jobs: new Map<string, HistoricalReadFrontier>(),
    };
    if (session && source.readCache) source.readCache.set(session, readCache);
    const result = readHistoricalLocations({ view, source, db, epochKey, frontier, readCache, fullHistory }, jobIds);
    if (session && !fullHistory)
      readCache.observed = stamp === null ? undefined : { path: epoch.path, stamp, frontier };
    return result;
  } catch (error) {
    if (isCodeDefect(error)) throw error;
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

function cachedHistoricalRead(cache: HistoricalReadCache, jobIds: readonly string[]): HistoricalSourceRead {
  const locations = new Map<string, JobLocation | null>();
  const absentJobs = new Set<string>();
  for (const jobId of jobIds) {
    const cached = cache.jobs.get(jobId) as HistoricalReadFrontier;
    locations.set(jobId, cached.location);
    if (cached.absent) absentJobs.add(jobId);
  }
  return {
    kind: 'read',
    locations,
    dispositions: new Map(jobIds.map((jobId) => [jobId, 'readable' as const])),
    unreadableJobs: new Set(),
    absentJobs,
  };
}

export function historicalSourceReader(index: JobLocationIndex): HistoricalSourceReader {
  return (epochKey, jobIds, session, fullHistory) =>
    readHistoricalSource(index, epochKey, jobIds, session, fullHistory);
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
      if (result.kind === 'contended') continue;
      if (result.kind === 'read') {
        source.refreshAttempts = 0;
        if (!source.refreshPending) index.clearUnknownLocations(epochKey);
      } else holdSourceFailure(index, epochKey, new Error(result.reason), ++source.refreshAttempts, false);
    } catch (error) {
      try {
        holdSourceFailure(index, epochKey, error, ++source.refreshAttempts, false);
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
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
): { kind: 'read' } | { kind: 'contended' } | { kind: 'unreadable'; reason: string } {
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
  const reader = retainedSourceReader(index, source.fingerprint);
  const dbPath = addressedEpoch.path;
  if (reader === undefined || observeStorePath(source.storage, dbPath) !== 'present')
    return { kind: 'unreadable', reason: 'Source is absent or its fingerprint is unsupported' };

  let releaseLock: (() => void) | null = null;
  let db: SqliteDatabasePort | null = null;
  try {
    const guard = acquireHistoricalRefreshGuard(source, addressedEpoch);
    if (guard.kind === 'contended') return guard;
    releaseLock = guard.release;
    verifyHistoricalIdentity(source, epochKey, addressedEpoch);
    db = source.storage.openSqliteDatabaseSync(dbPath, { readOnly: true });
    db.exec('BEGIN');
    return refreshHistoricalBatch(index, source, db, epochKey, jobIds, budget);
  } catch (error) {
    // An unreadable refresh cannot certify absence or void an earlier terminal certificate.
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : 'Historical source cannot be read' };
  } finally {
    db?.close();
    releaseLock?.();
  }
}

function acquireHistoricalRefreshGuard(
  source: HistoricalEpochSource,
  addressedEpoch: ResolvedStoreEpoch,
): { kind: 'acquired'; release: () => void } | { kind: 'contended' } {
  const lockPath = join(dirname(addressedEpoch.path), STORE_LOCK_FILE_NAME);
  if (source.storage.existsSync(lockPath)) {
    const guard = source.storage.lstatSync(lockPath, { bigint: true });
    if (!guard.isFile() || guard.nlink !== 1n) throw new Error('Source lock is malformed.');
  }
  // A contended guard must defer rather than block the sweep.
  try {
    return { kind: 'acquired', release: createSharedFileLockSync(lockPath, 0) };
  } catch (error) {
    if (error instanceof Error && 'errcode' in error && error.errcode === SQLITE_BUSY_ERRCODE)
      return { kind: 'contended' };
    throw error;
  }
}

/**
 * A certificate may claim only the job events its sweep applied, so its high-water mark is the last job event at or
 * before the swept frontier. Both queries must range-walk `seq`; the unary `+` keeps the planner off any index that
 * leads with `stream_kind`, which cannot range on `seq`.
 */
function jobStreamHighWaterSeq(db: HistoricalDatabase, frontier: number): number {
  return z
    .object({ seq: z.number().int().nonnegative() })
    .parse(
      db
        .prepare(
          "SELECT COALESCE((SELECT seq FROM events WHERE seq <= ? AND +stream_kind = 'job' ORDER BY seq DESC LIMIT 1), 0) AS seq",
        )
        .get(frontier),
    ).seq;
}

function hasJobEventsAfter(db: HistoricalDatabase, seq: number): boolean {
  return (
    z
      .object({ found: z.number().int() })
      .parse(db.prepare("SELECT EXISTS(SELECT 1 FROM events WHERE seq > ? AND +stream_kind = 'job') AS found").get(seq))
      .found === 1
  );
}

function refreshHistoricalBatch(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: SqliteDatabasePort,
  epochKey: string,
  jobIds: readonly string[],
  budget?: { remaining: number },
): ReturnType<typeof refreshHistoricalEpoch> {
  const frontier = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const revision = index.revision(epochKey);
  if (jobIds.length === 0 && source.sweep?.revision === revision && source.sweep.frontier === frontier)
    return { kind: 'read' };
  // Only job events change a retained location, so a frontier moved by other streams alone leaves nothing to refresh.
  if (
    jobIds.length === 0 &&
    source.refreshPending === undefined &&
    source.sweep?.revision === revision &&
    index.certificate(epochKey) !== null &&
    !hasJobEventsAfter(db, source.sweep.frontier)
  ) {
    source.sweep = { revision, frontier };
    return { kind: 'read' };
  }
  const requested = historicalRefreshJobIds(index, source, db, epochKey, jobIds, revision);
  let failed = false;
  for (const jobId of [...requested]) {
    if (budget && budget.remaining <= 0) {
      source.refreshPending = { jobIds: [...requested], frontier: source.refreshPending?.frontier ?? frontier };
      return failed
        ? { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' }
        : { kind: 'read' };
    }
    if (budget) budget.remaining--;
    if (refreshRequestedHistoricalJob(index, source, db, epochKey, jobId, requested)) failed = true;
  }
  return completeHistoricalRefresh(index, source, db, epochKey, requested, failed, frontier);
}

function historicalRefreshJobIds(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  epochKey: string,
  jobIds: readonly string[],
  revision: number,
): Set<string> {
  const incremental = jobIds.length === 0 && source.sweep?.revision === revision;
  return new Set(
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
}

function refreshRequestedHistoricalJob(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  epochKey: string,
  jobId: string,
  requested: Set<string>,
): boolean {
  const retainedRead = readRetainedLocation(index, jobId);
  if (retainedRead.kind === 'unreadable') {
    requested.delete(jobId);
    return false;
  }
  const location = retainedRead.location;
  if (
    location !== null &&
    (!sameEpoch(location.epochKey, epochKey) ||
      (requireRetainedSourceReader(index, source.fingerprint).terminalIsImmutable &&
        location.disposition === 'terminal' &&
        hasReadableTerminalDetail(location)))
  ) {
    requested.delete(jobId);
    return false;
  }
  try {
    const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
    if (raw === undefined) {
      requested.delete(jobId);
      return false;
    }
    requested.delete(jobId);
    return refreshHistoricalJob(index, source, db, epochKey, jobId, location, raw, requested);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    requested.add(jobId);
    return true;
  }
}

function registerKnownHistoricalJobs(
  index: JobLocationIndex,
  epochKey: string,
  knownJobs: readonly KnownHistoricalJob[],
  budget?: { remaining: number },
): void {
  for (const known of knownJobs) {
    const retained = readRetainedLocation(index, known.jobId);
    if (retained.kind === 'unreadable' || retained.location !== null) continue;
    if (budget && budget.remaining <= 0) break;
    if (budget) budget.remaining--;
    index.register(known.jobId, epochKey, known.subject);
  }
}

function historicalSeedSubjects(
  index: JobLocationIndex,
  seed: NonNullable<HistoricalEpochSource['seed']>,
  db: HistoricalDatabase,
  fingerprint: string,
) {
  if (seed.subjects === undefined || seed.launchSeqs === undefined || seed.members === undefined) {
    const rows = db.prepare('SELECT job_id FROM projection_jobs ORDER BY job_id ASC').all() as { job_id: string }[];
    const launches = db
      .prepare("SELECT stream_id, seq FROM events WHERE stream_kind = 'job' AND type = ? ORDER BY seq ASC")
      .all(requireRetainedSourceReader(index, fingerprint).openedEventType) as {
      stream_id: string;
      seq: number;
    }[];
    seed.subjects = [...new Set([...launches.map((launch) => launch.stream_id), ...rows.map((row) => row.job_id)])];
    seed.launchSeqs = new Map(launches.map((launch) => [launch.stream_id, launch.seq]));
    seed.members = new Set(seed.subjects);
  }
  return { subjects: seed.subjects, launchSeqs: seed.launchSeqs, members: seed.members };
}

function hydrateHistoricalSeedJob(
  index: JobLocationIndex,
  db: HistoricalDatabase,
  epochKey: string,
  jobId: string,
  launchSeq: number | undefined,
  knownJobs: readonly KnownHistoricalJob[],
  fingerprint: string,
  jobsRoot: string,
  observed: Set<string>,
): void {
  const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
  if (source === undefined) throw new Error('Retained source is unregistered');
  requireRetainedSourceReader(index, fingerprint).hydrateSeed({
    index,
    db,
    epochKey,
    jobId,
    launchSeq,
    knownJobs,
    fingerprint,
    jobsRoot,
    observed,
  });
}

function hydrateFrozenSeedJob({
  index,
  db,
  epochKey,
  jobId,
  launchSeq,
  knownJobs,
  fingerprint,
  jobsRoot,
  observed,
}: Parameters<RetainedSourceReader['hydrateSeed']>[0]): void {
  const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
  if (source === undefined) throw new Error('Retained source is unregistered');
  let registered = false;
  if (launchSeq !== undefined) {
    const row = z
      .object({ body: z.instanceof(Uint8Array) })
      .parse(db.prepare('SELECT stream_id, body FROM events WHERE seq = ?').get(launchSeq));
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
    return;
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
    return;
  }
  index.recordTerminal(jobId, detail, historicalResultPath(jobsRoot, jobId), terminal.seq);
  try {
    repairRetainedResult(index, source, db, jobId);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    /* Publication failure cannot hide the retained outcome. */
  }
}

function completeHistoricalSeed(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  frontier: number,
  db: HistoricalDatabase,
  epochKey: string,
  observed: Set<string>,
  certifyRetiredEpoch: boolean,
): HistoricalSeedResult {
  index.clearUnknownLocations(epochKey);
  source.seed = undefined;
  source.attempts = 0;
  source.refreshAttempts = 0;
  source.sweep = { revision: index.revision(epochKey), frontier };
  if (!certifyRetiredEpoch) return { kind: 'uncertified', knownJobIds: [...observed] };
  const certificate = index.certify(epochKey, jobStreamHighWaterSeq(db, frontier));
  return certificate === null
    ? { kind: 'unrecoverable-retained', knownJobIds: [...observed], reason: 'known-jobs-unresolved' }
    : { kind: 'complete', jobIds: certificate.jobIds };
}

function unregisteredHistoricalRead(view: JobLocationView, epochKey: string): HistoricalSourceRead {
  const hold = view.unknownLocationHolds().find((hold) => sameEpochOrFallbackAddress(hold.epochKey, epochKey));
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
            ? `Epoch ${epochToken(epochKey).slice(0, 8)} is present but not yet registered by this coordinator; epoch maintenance registers present epochs every 5 s`
            : `Epoch ${epochToken(epochKey).slice(0, 8)} cannot be observed by this coordinator; epoch maintenance re-observes it every 5 s and settles after 3 consecutive failures`),
      };
}

function readVouchedHistoricalCache(
  source: HistoricalEpochSource,
  jobIds: readonly string[],
  session: object | undefined,
  fullHistory: boolean,
): HistoricalSourceRead | null {
  const observed = session && !fullHistory ? source.readCache?.get(session) : undefined;
  const vouched = (jobId: string): boolean => {
    const cached = observed?.jobs.get(jobId);
    return (
      cached !== undefined &&
      (cached.frontier === observed?.observed?.frontier || cached.location?.disposition === 'terminal')
    );
  };
  if (
    observed?.observed &&
    jobIds.every(vouched) &&
    sourceReadStamp(source.storage, observed.observed.path) === observed.observed.stamp
  )
    return cachedHistoricalRead(observed, jobIds);
  return null;
}

interface HistoricalLocationReadContext {
  view: JobLocationView;
  source: HistoricalEpochSource;
  db: HistoricalDatabase;
  epochKey: string;
  frontier: number;
  readCache: HistoricalReadCache;
  fullHistory: boolean;
}

function readHistoricalLocations(
  context: HistoricalLocationReadContext,
  jobIds: readonly string[],
): Extract<HistoricalSourceRead, { kind: 'read' }> {
  const { view, epochKey, readCache } = context;
  const locations = new Map<string, JobLocation | null>();
  const unreadableJobs = new Set<string>();
  const absentJobs = new Set<string>();
  const dispositions = new Map<string, SourceReadDisposition>();
  for (const jobId of jobIds) {
    try {
      dispositions.set(jobId, 'readable');
      const result = readHistoricalLocation(context, jobId);
      locations.set(jobId, result.location);
      if (result.absent) absentJobs.add(jobId);
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      // The stamp published below certifies only answers this observation produced, so a failed read keeps none.
      readCache.jobs.delete(jobId);
      dispositions.set(
        jobId,
        view.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.retryScheduled === false
          ? 'settled-unreadable'
          : sourceReadFailureDisposition(error),
      );
      unreadableJobs.add(jobId);
    }
  }
  return { kind: 'read', locations, dispositions, unreadableJobs, absentJobs };
}

function readHistoricalLocation(
  context: HistoricalLocationReadContext,
  jobId: string,
): { location: JobLocation | null; absent?: boolean } {
  const { view, source, frontier, readCache, fullHistory } = context;
  if (source.seed?.members && source.seed.frontier === frontier && !source.seed.members.has(jobId)) {
    return { location: null, absent: true };
  }
  const cached = fullHistory ? undefined : readCache.jobs.get(jobId);
  if (
    cached?.frontier === frontier ||
    (requireRetainedSourceReader(view, source.fingerprint).terminalIsImmutable &&
      cached?.location?.disposition === 'terminal')
  ) {
    return cached;
  }
  return readProjectedHistoricalLocation(context, jobId, cached);
}

function readProjectedHistoricalLocation(
  context: HistoricalLocationReadContext,
  jobId: string,
  cached: HistoricalReadFrontier | undefined,
): { location: JobLocation | null; absent?: boolean } {
  const { view, source, db, epochKey, frontier, readCache, fullHistory } = context;
  const raw = db.prepare('SELECT * FROM projection_jobs WHERE job_id = ?').get(jobId);
  const jobSeq = typeof raw === 'object' && raw !== null && 'last_seq' in raw ? raw.last_seq : undefined;
  if (cached?.jobSeq !== undefined && cached.jobSeq === jobSeq) {
    readCache.jobs.set(jobId, { ...cached, frontier });
    return { location: cached.location, absent: false };
  }
  const result = requireRetainedSourceReader(view, source.fingerprint).readLocation(
    db,
    source,
    epochKey,
    jobId,
    raw,
    fullHistory,
  );
  if (!fullHistory) readCache.jobs.set(jobId, { frontier, ...result });
  return result;
}

function readFrozenLocation(
  db: HistoricalDatabase,
  source: HistoricalEpochSource,
  epochKey: string,
  jobId: string,
  raw: unknown,
  fullHistory: boolean,
): { location: JobLocation | null; absent: boolean; jobSeq?: number } {
  const events = fullHistory ? readEvents(db, jobId) : readMetadata(db, jobId);
  if (raw === undefined) {
    if (events.some((event) => event.type === 'job.terminal.recorded'))
      throw new HistoricalDecodeError('Historical job terminal cannot be decoded');
    return { location: null, absent: events.length === 0 };
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
      : { terminalSeq: terminal.seq, resultPath: historicalResultPath(source.jobsRoot, jobId) }),
    detail: { kind: 'recorded', value: { ...detail, epochKey } },
  };
  if (terminal !== undefined && !hasReadableTerminalDetail(location))
    throw new HistoricalDecodeError('Historical job terminal cannot be decoded');
  return { location, absent: false, jobSeq: row.last_seq };
}

function refreshHistoricalJob(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  epochKey: string,
  jobId: string,
  location: JobLocation | null,
  raw: unknown,
  requested: Set<string>,
): boolean {
  return requireRetainedSourceReader(index, source.fingerprint).refresh({
    index,
    source,
    db,
    epochKey,
    jobId,
    location,
    raw,
    requested,
  });
}

function refreshFrozenJob({
  index,
  source,
  db,
  epochKey,
  jobId,
  location,
  raw,
  requested,
}: Parameters<RetainedSourceReader['refresh']>[0]): boolean {
  const row = (source.fingerprint === FINGERPRINT_0110 ? newerProjectionSchema : olderProjectionSchema).parse(raw);
  const appended = readEvents(db, row.job_id, source.sweep?.frontier ?? 0);
  if (source.sweep && appended.length === 0 && !isTerminalPhase(row.phase)) return false;
  const events =
    isTerminalPhase(row.phase) || appended.some((event) => event.type === 'job.terminal.recorded')
      ? readEvents(db, row.job_id)
      : appended;
  const detail = historicalDetail(
    db,
    {
      ...row,
      work_dir: historicalWorkDirSchema.nullable().parse(row.work_dir ?? location?.subject.workDir ?? row.project_root),
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
    return false;
  }
  let failed = false;
  const resultPath = historicalResultPath(source.jobsRoot, row.job_id);
  try {
    index.recordTerminal(row.job_id, detail, resultPath, terminal.seq);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    failed = true;
    requested.add(jobId);
    index.resultRepairFailures.add(row.job_id);
  }
  try {
    repairHistoricalResult(index, source, db, row.job_id);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      backendLog.warn(`Retained job observation requires its existing recovery owner: ${String(error)}`);
    /* Failed publication must not hide a retained terminal. */
  }
  return failed;
}

function completeHistoricalRefresh(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  epochKey: string,
  requested: Set<string>,
  failed: boolean,
  frontier: number,
): { kind: 'read' } | { kind: 'unreadable'; reason: string } {
  if (failed) return { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' };
  for (const jobId of requested) {
    if (requireRetainedSourceReader(index, source.fingerprint).pendingIsUnreadable(db, jobId))
      return { kind: 'unreadable', reason: 'Historical source could not be decoded or retained' };
  }
  const sweptFrontier = source.refreshPending?.frontier ?? frontier;
  index.clearUnknownLocations(epochKey);
  index.certify(epochKey, jobStreamHighWaterSeq(db, sweptFrontier));
  source.sweep = { revision: index.revision(epochKey), frontier: sweptFrontier };
  source.refreshPending = undefined;
  return { kind: 'read' };
}

function retainSourceCurrentJob(
  index: JobLocationIndex,
  source: HistoricalEpochSource,
  db: HistoricalDatabase,
  jobId: string,
): void {
  retainCurrentJob(
    index,
    db as Database,
    source.epochKey,
    jobId,
    source.jobsRoot,
    { ...source.runtime, time: index.time },
    () => {
      verifyHistoricalIdentity(source, source.epochKey, resolveHistoricalAddress(source, source.epochKey));
    },
  );
}

const currentSourceReader: RetainedSourceReader = {
  openedEventType: 'job.opened',
  terminalIsImmutable: false,
  resultInput: ({ index, epochKey, db, jobId, execution }) =>
    currentResultInput(db, epochKey, jobId, execution, index.workflowReport),
  prepare: ({ index, db, epochKey, jobId, jobsRoot, runtime }) =>
    retainCurrentJob(index, db, epochKey, jobId, jobsRoot, runtime, () => {
      if (!sameEpoch(index.read(jobId)?.epochKey, epochKey)) throw new Error('Retained job changed source');
    }),
  repair: retainSourceCurrentJob,
  hydrateSeed: ({ index, db, epochKey, jobId, observed }) => {
    const source = historicalSources.get(index)?.get(epochIdentity(epochKey));
    if (source === undefined) throw new Error('Retained source is unregistered');
    retainSourceCurrentJob(index, source, db, jobId);
    observed.add(jobId);
  },
  readLocation: (db, source, epochKey, jobId, raw) => {
    const location = loadRetainedCurrentJob(db as Database, epochKey, jobId, source.jobsRoot);
    const jobSeq =
      typeof raw === 'object' && raw !== null && 'last_seq' in raw && typeof raw.last_seq === 'number'
        ? raw.last_seq
        : undefined;
    return { location, absent: location === null, jobSeq };
  },
  refresh: ({ index, source, db, jobId }) => {
    retainSourceCurrentJob(index, source, db, jobId);
    return false;
  },
  pendingIsUnreadable: () => true,
};

const frozenSourceReader: RetainedSourceReader = {
  openedEventType: 'job.launch.requested',
  terminalIsImmutable: true,
  resultInput: ({ db, jobId }) => historicalResultInput(db, jobId),
  prepare: prepareFrozenJob,
  repair: repairHistoricalResult,
  hydrateSeed: hydrateFrozenSeedJob,
  readLocation: readFrozenLocation,
  refresh: refreshFrozenJob,
  pendingIsUnreadable: (db, jobId) => readEvents(db, jobId).some((event) => event.type === 'job.terminal.recorded'),
};
