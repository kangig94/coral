import { currentResultArtifacts } from './retained-current.js';
import { executionRetryStatusSchema } from './records.js';
import type { RecoveryObservation } from '../recovery/phase-observation.js';
import { createHash } from 'node:crypto';
import { sameEpoch, epochHoldDirectory, epochIdentity } from '../store/epoch/identity.js';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { acquireDirectoryLockSync } from '../infra/fs-lock.js';
import { backendLog } from '../infra/backend-log.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ResolvableCoralEventInput } from '../store/envelope.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import { usageSummarySchema } from '../providers/contract.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobExecutionRequestedBodySchema } from './launch.js';
import { executionOrdinalSchema } from './launch.js';
import { jobKindSchema, type JobDetailResponse, type JobKind } from './records.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';
import { type ResolvedStoreEpoch } from '../store/epoch/types.js';
import { observeResolvedStoreEpoch } from '../store/epoch/observation.js';
import { observeStorePath } from '../store/path-observation.js';
import { protectedStoreEpochRoot } from '../store/epoch/protection.js';
import { TerminalResultExportOwner, resultRepairFailuresFor } from './terminal/export.js';
import { resultPathFor } from './paths.js';
import { type WorkflowReportPort } from './terminal/render.js';
import { hasReadableTerminalDetail, validatedTerminal } from './terminal/identity.js';
import { withTerminalSource } from './terminal/source.js';
import { proveResultArtifactsDurable, proveResultArtifactsDurableAsync } from './terminal/artifact.js';
import { isCodeDefect, sourceReadFailureDisposition } from './source-read.js';
import { composeReducers } from '../store/reducers.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { jobsRegistry } from './events.js';
import type { Database } from '../store/db.js';
import { jobRetentionCutoff, type TerminalEligibility } from './export-retention.js';
import {
  type HistoricalSourceRead,
  prepareRetainedJob,
  retainedResultInput,
  readHistoricalSource,
  registeredHistoricalEpoch,
  type HistoricalSourceReader,
} from './historical-reader.js';
import type { RetentionRunBudget } from '../store/retention-outcome.js';

const RELEASE_PLAN_BATCH = 16;

type ReleasePlan = Readonly<{
  artifacts: readonly string[];
  /** Null when a planned record's stat cannot show it unchanged, which makes the plan unrememberable. */
  locations: ReadonlyMap<string, string> | null;
  fromSource: boolean;
}>;

type RememberedReleasePlan = ReleasePlan & Readonly<{ revision: number; locations: ReadonlyMap<string, string> }>;

const subjectSchema = z
  .object({
    projectRoot: z.string().min(1),
    workDir: z.string().nullable(),
    jobKind: z.enum(['provider', 'workflow', 'kb']),
  })
  .passthrough();
const controllerSchema = z
  .object({
    buildSetId: z.string().min(1),
    instanceId: z.string().min(1),
    controlGeneration: z.number().int().safe().nonnegative(),
  })
  .passthrough();
const locationIdentitySchema = z.object({
  version: z.literal('v1'),
  jobId: z.string().min(1),
  epochKey: z.string().min(1),
  subject: subjectSchema,
  controller: controllerSchema.optional(),
  disposition: z.enum(['active-owner', 'unresolved', 'terminal']),
  terminalSeq: z.number().int().safe().nonnegative().optional(),
  resultPath: z.string().optional(),
});
const jobEventBaseSchema = z.object({
  jobId: z.string(),
  sessionId: z.string().nullable().default(null),
  seq: z.number().int().safe().nonnegative(),
  ts: z.string(),
});

function storedPassthrough<T extends z.ZodTypeAny>(schema: T): T {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, storedPassthrough(value as z.ZodTypeAny)]),
    );
    return schema.extend(shape).passthrough() as unknown as T;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options.map((option: z.ZodDiscriminatedUnionOption<string>) => storedPassthrough(option));
    return z.discriminatedUnion(
      schema.discriminator,
      options as [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]],
    ) as unknown as T;
  }
  if (schema instanceof z.ZodArray) return z.array(storedPassthrough(schema.element)) as unknown as T;
  if (schema instanceof z.ZodOptional) return storedPassthrough(schema.unwrap()).optional() as T;
  if (schema instanceof z.ZodNullable) return storedPassthrough(schema.unwrap()).nullable() as T;
  return schema;
}

// Another build may write a detail this one cannot decode; that detail is reported unreadable, never guessed at.
export const storedJobDetailSchema: z.ZodType<JobDetailResponse, z.ZodTypeDef, unknown> = storedPassthrough(
  z
    .object({
      status: z
        .object({
          jobId: z.string().min(1),
          owner: executionOwnerSchema,
          sessionId: z.string().nullable(),
          execution: executionOrdinalSchema.nullable().optional().default(null),
          finishing: z.boolean().optional(),
          finishingStatus: executionRetryStatusSchema.optional(),
          provider: z.string().nullable(),
          projectRoot: z.string().min(1),
          workDir: canonicalWorkDirWireSchema.nullable(),
          backendNamespace: z.string(),
          bundleHash: z.string().optional(),
          jobKind: jobKindSchema,
          parentWorkflowJobId: z.string().optional(),
          workflowSlotId: z.string().optional(),
          workflowSlotGeneration: z.number().int().safe().nonnegative().optional(),
          replacesWorkflowJobId: z.string().optional(),
          phase: z.enum(['queued', 'launching', 'running', 'completed', 'error', 'aborted']),
          updatedAt: z.string(),
          lastSeq: z.number().int().safe().nonnegative().optional(),
          result: jobTerminalSchema.optional(),
        })
        .passthrough(),
      events: z.array(
        z.discriminatedUnion('type', [
          jobEventBaseSchema
            .extend({ type: z.literal('progress'), message: z.string(), timing: jobProgressTimingSchema })
            .passthrough(),
          jobEventBaseSchema
            .extend({ type: z.literal('terminal'), result: jobTerminalSchema, usage: usageSummarySchema.optional() })
            .passthrough(),
        ]),
      ),
      readiness: z.enum(['pending', 'queued', 'ready', 'error']),
      executionAddressing: z.literal('lifetime').optional(),
      exit: jobTerminalSchema
        .extend({ diagnostics: jobDiagnosticsSchema, endTime: z.string() })
        .passthrough()
        .nullable(),
    })
    .passthrough(),
);
function durableJobDetail(detail: JobDetailResponse): JobDetailResponse {
  if (detail.status.execution === null || detail.status.backendNamespace === null)
    throw new Error('A durable job detail requires an execution and backend namespace.');
  return storedJobDetailSchema.parse(detail);
}

const storedExecutionSchema = z
  .object({
    execution: executionOrdinalSchema,
    requestedSeq: z.number().int().positive().safe(),
    seq: z.number().int().positive().safe(),
    resultPath: z.string().min(1),
    resultMarkdown: z.string().optional(),
    detail: storedJobDetailSchema,
  })
  .passthrough();
const locationSchema = locationIdentitySchema
  .extend({
    detail: z.unknown().optional(),
    executions: z.array(storedExecutionSchema).optional(),
    latestExecution: executionOrdinalSchema.optional(),
    openExecution: executionOrdinalSchema.optional(),
    pendingAdmission: z
      .object({
        execution: executionOrdinalSchema,
        priorTerminalSeq: z.number().int().positive().safe().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JobExecutionLocation = z.infer<typeof storedExecutionSchema>;

const revisionSchema = z
  .object({ version: z.literal('v1'), revision: z.number().int().safe().nonnegative() })
  .passthrough();
const certificateSchema = z
  .object({
    version: z.literal('v1'),
    epochKey: z.string().min(1),
    revision: z.number().int().safe().nonnegative(),
    jobIds: z.array(z.string().min(1)),
    terminalHighWaterSeq: z.number().int().safe().nonnegative(),
  })
  .passthrough();
const unknownHoldSchema = z
  .object({
    version: z.literal('v1'),
    reason: z.string().min(1),
    epochKey: z.string().optional(),
    retryScheduled: z.boolean().optional(),
  })
  .passthrough();

type StoredJobLocation = z.infer<typeof locationSchema>;

export type JobLocationDetail =
  | Readonly<{ kind: 'recorded'; value: JobDetailResponse }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable' }>;

export type JobLocation = z.infer<typeof locationIdentitySchema> & {
  detail: JobLocationDetail;
  executions?: JobExecutionLocation[];
  latestExecution?: number;
  openExecution?: number;
  pendingAdmission?: StoredJobLocation['pendingAdmission'];
};

export type UnknownLocationHold = Readonly<
  { reason: string; retryScheduled: boolean } & (
    | { epochKey: string; directory?: undefined }
    | { epochKey?: undefined; directory: string }
  )
>;

export class LocationObservationDeferred extends Error {}

export interface JobLocationView {
  readonly currentFingerprint?: string | null;
  readHistorical?: HistoricalSourceReader;
  historicalSourceState?(epochKey: string): 'present' | 'absent' | 'unobservable';
  readonly time: TimePort;
  read(jobId: string): JobLocation | null;
  observePoll?<T>(read: () => T, liveJobIds?: ReadonlySet<string>): T;
  resultPathFor(jobId: string, execution: number): string;
  unknownLocationHolds(): UnknownLocationHold[];
}

function viewLocation(stored: StoredJobLocation): JobLocation {
  const { detail: raw, ...identity } = stored;
  if (
    stored.executions?.some(
      (entry, index, entries) =>
        entry.execution !== index + 1 ||
        entry.requestedSeq >= entry.seq ||
        (index > 0 && entries[index - 1].seq >= entry.requestedSeq) ||
        entry.detail.status.execution !== entry.execution ||
        validatedTerminal(entry.detail, stored.jobId, stored.epochKey, entry.seq, entry) === null,
    )
  )
    return { ...identity, detail: { kind: 'unreadable' } };
  if (raw === undefined) return { ...identity, detail: { kind: 'absent' } };
  const parsed = storedJobDetailSchema.safeParse(raw);
  if (!parsed.success) return { ...identity, detail: { kind: 'unreadable' } };
  const location: JobLocation = { ...identity, detail: { kind: 'recorded', value: parsed.data } };
  const terminalPresent =
    stored.disposition === 'terminal' ||
    parsed.data.exit !== null ||
    parsed.data.status.result !== undefined ||
    parsed.data.events.some((event) => event.type === 'terminal');
  return terminalPresent &&
    (stored.terminalSeq === undefined ||
      validatedTerminal(parsed.data, stored.jobId, stored.epochKey, stored.terminalSeq) === null)
    ? { ...identity, detail: { kind: 'unreadable' } }
    : location;
}

const omittedDetailKeys: Record<string, readonly string[]> = {
  status: [
    'bundleHash',
    'parentWorkflowJobId',
    'workflowSlotId',
    'workflowSlotGeneration',
    'replacesWorkflowJobId',
    'lastSeq',
    'result',
  ],
  'events[]': ['message', 'timing', 'result', 'usage'],
  'exit.diagnostics': ['warnings', 'usage', 'processExit', 'byteCounts'],
};

function preserveStoredDetail<T>(stored: unknown, next: T, path = ''): T {
  if (Array.isArray(next)) {
    const previous = Array.isArray(stored) ? stored : [];
    const bySeq = new Map(
      previous
        .filter(
          (candidate) =>
            typeof candidate === 'object' && candidate !== null && 'seq' in candidate && 'type' in candidate,
        )
        .map((candidate) => [`${candidate.seq}:${candidate.type}`, candidate]),
    );
    return next.map((item, index) => {
      const event = typeof item === 'object' && item !== null && 'seq' in item && 'type' in item;
      const matching = event ? bySeq.get(`${item.seq}:${item.type}`) : previous[index];
      return preserveStoredDetail(matching, item, `${path}[]`);
    }) as T;
  }
  if (
    typeof next !== 'object' ||
    next === null ||
    typeof stored !== 'object' ||
    stored === null ||
    Array.isArray(stored)
  )
    return next;
  const result: Record<string, unknown> = { ...stored };
  for (const key of omittedDetailKeys[path] ?? []) if (!(key in next)) delete result[key];
  for (const [key, value] of Object.entries(next))
    result[key] = preserveStoredDetail(result[key], value, path ? `${path}.${key}` : key);
  return result as T;
}

export type JobLocationSubject = Readonly<{ projectRoot: string; workDir: string | null; jobKind: JobKind }>;
export type JobLocationController = z.infer<typeof controllerSchema>;
export type JobLocationCertificate = z.infer<typeof certificateSchema>;

function atomicJson(runtime: Runtime, path: string, value: unknown): string {
  const parent = dirname(path);
  runtime.storage.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const raw = `${JSON.stringify(value)}\n`;
  if (!runtime.storage.writeAtomicDurableSync(path, raw, { mode: 0o600 })) {
    throw new Error(`Could not write job location record: ${path}`);
  }
  return raw;
}

function optionalJson<T, Input>(
  runtime: Runtime,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, Input>,
  observation?: RecoveryObservation,
): T | null {
  try {
    const content = runtime.storage.readFileSync(path, 'utf-8');
    observation?.record('job-locations', { reads: 1 });
    return schema.parse(JSON.parse(content) as unknown);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export class JobLocationIndex {
  get resultRepairFailures(): Set<string> {
    return resultRepairFailuresFor(this);
  }
  readonly time: TimePort;
  private readonly root: string;
  private locationsStamp: string | undefined;
  private readonly epochRevisions = new Map<string, number>();
  private readonly certificates = new Map<string, { stamp: string; value: JobLocationCertificate | null }>();
  private readonly releasePlans = new Map<string, RememberedReleasePlan>();
  private locationsUnreadable: Array<{ file: string; epochKey: string | null }> = [];
  private readonly locationsByEpoch = new Map<string, JobLocation[]>();
  private readonly runtime: Runtime;
  private strayEpochEntryReported = false;

  get jobsRoot(): string {
    return this.runtime.paths.coral.exports.jobsRoot;
  }

  readonly workflowReport?: WorkflowReportPort;
  readonly currentFingerprint: string | null;

  constructor(
    runtime: Runtime,
    stateRoot: string,
    workflowReport?: WorkflowReportPort,
    currentFingerprint: string | null = null,
  ) {
    this.workflowReport = workflowReport;
    this.currentFingerprint = currentFingerprint;
    this.runtime = runtime;
    this.time = runtime.time;
    this.root = join(stateRoot, 'job-locations.v1');
  }

  private jobPath(jobId: string): string {
    return join(this.root, 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
  }

  private readonly epochDirectories = new Map<string, string>();
  private epochDirectoriesStamp: string | undefined;

  private epochPath(epochKey: string, name: string): string {
    const root = join(this.root, 'epochs');
    const stat = this.runtime.storage.existsSync(root) ? this.runtime.storage.lstatSync(root, { bigint: true }) : null;
    const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}` : 'absent';
    if (this.epochDirectoriesStamp !== stamp) {
      this.epochDirectories.clear();
      this.epochDirectoriesStamp = stamp;
    }
    const identity = epochIdentity(epochKey);
    let directory = this.epochDirectories.get(identity);
    if (!directory) {
      directory = epochHoldDirectory(epochKey);
      if (this.runtime.storage.existsSync(root) && !this.runtime.storage.existsSync(join(root, directory))) {
        for (const candidate of this.runtime.storage.readdirSync(root)) {
          if (this.directoryEpochKeys(root, candidate).some((named) => sameEpoch(named, epochKey))) {
            directory = candidate;
            break;
          }
        }
      }
      // A new directory's naming record lands after its creation changed the epochs root, so a lookup that found no
      // directory is never kept.
      if (this.runtime.storage.existsSync(join(root, directory))) this.epochDirectories.set(identity, directory);
    }
    return join(this.root, 'epochs', directory, name);
  }

  private readonly namedDirectories = new Map<string, { stamp: string; epochKeys: string[] }>();

  /** The epoch keys a directory's records name, parsed again only after that directory's own entries change. */
  private directoryEpochKeys(root: string, candidate: string): string[] {
    let stamp: string;
    try {
      const stat = this.runtime.storage.lstatSync(join(root, candidate), { bigint: true });
      stamp = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return [];
    }
    const cached = this.namedDirectories.get(candidate);
    if (cached?.stamp === stamp) return cached.epochKeys;
    const epochKeys = ['revision.v1.json', 'certificate.v1.json', 'unknown-locations.v1.json'].flatMap((file) => {
      try {
        const stored = z
          .object({ epochKey: z.string() })
          .safeParse(JSON.parse(this.runtime.storage.readFileSync(join(root, candidate, file), 'utf-8')));
        return stored.success ? [stored.data.epochKey] : [];
      } catch {
        return [];
      }
    });
    this.namedDirectories.set(candidate, { stamp, epochKeys });
    return epochKeys;
  }

  /**
   * Equivalent addresses of one epoch share its identity lock, under which the epoch's directory is resolved and, when
   * new, created already naming its epoch; a released writer, which knows only the directory lock, still shares that.
   */
  private heldEpoch: string | null = null;

  private withRevisionLock<T>(epochKey: string, action: () => T): T {
    if (this.heldEpoch !== null && sameEpoch(this.heldEpoch, epochKey)) return action();
    const identityLock = join(
      this.root,
      'revision-locks',
      createHash('sha256').update(epochIdentity(epochKey)).digest('hex'),
    );
    this.runtime.storage.mkdirSync(dirname(identityLock), { recursive: true, mode: 0o700 });
    return this.withDirectoryLock(identityLock, () => {
      const revisionPath = this.epochPath(epochKey, 'revision.v1.json');
      if (!this.runtime.storage.existsSync(dirname(revisionPath)))
        atomicJson(this.runtime, revisionPath, { version: 'v1', epochKey, revision: 0 });
      return this.withDirectoryLock(this.epochPath(epochKey, 'revision.lock'), () => {
        const previous = this.heldEpoch;
        this.heldEpoch = epochKey;
        try {
          return action();
        } finally {
          this.heldEpoch = previous;
        }
      });
    });
  }

  private withDirectoryLock<T>(lockDir: string, action: () => T): T {
    const release = acquireDirectoryLockSync(lockDir, {
      storage: this.runtime.storage,
      time: this.runtime.time,
    });
    try {
      return action();
    } finally {
      release();
    }
  }

  private advanceRevision(epochKey: string): number {
    this.locationsStamp = undefined;
    const revisionPath = this.epochPath(epochKey, 'revision.v1.json');
    const previous = optionalJson(this.runtime, revisionPath, revisionSchema);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('Job location revision exhausted its counter.');
    atomicJson(this.runtime, revisionPath, { ...previous, version: 'v1', epochKey, revision });
    return revision;
  }

  private pollReads: Map<string, StoredJobLocation | null> | undefined;

  private pollReadCount = 0;
  private livePollJobs: ReadonlySet<string> = new Set();

  observePoll<T>(read: () => T, liveJobIds: ReadonlySet<string> = new Set()): T {
    this.pollReadCount = 0;
    this.livePollJobs = liveJobIds;
    this.pollReads = new Map();
    try {
      return read();
    } finally {
      this.pollReads = undefined;
      this.livePollJobs = new Set();
    }
  }

  private readStored(jobId: string, observation?: RecoveryObservation): StoredJobLocation | null {
    if (this.pollReads?.has(jobId)) return this.pollReads.get(jobId) ?? null;
    if (this.pollReads && !this.livePollJobs.has(jobId)) {
      if (this.pollReadCount >= 32)
        throw new LocationObservationDeferred('Location observation deferred to the next bounded poll');
      this.pollReadCount++;
    }
    const stored = optionalJson(this.runtime, this.jobPath(jobId), locationSchema, observation);
    this.pollReads?.set(jobId, stored);
    return stored;
  }

  read(jobId: string, observation?: RecoveryObservation): JobLocation | null {
    const stored = this.readStored(jobId, observation);
    return stored === null ? null : viewLocation(stored);
  }

  historicalSourceState(epochKey: string): 'present' | 'absent' | 'unobservable' {
    try {
      const epoch = observeResolvedStoreEpoch(this.runtime, epochKey);
      return epoch ? observeStorePath(this.runtime.storage, epoch.path) : 'unobservable';
    } catch {
      return 'unobservable';
    }
  }

  readHistorical(
    epochKey: string,
    jobIds: readonly string[],
    session?: object,
    fullHistory = false,
  ): HistoricalSourceRead {
    return readHistoricalSource(this, epochKey, jobIds, session, fullHistory);
  }

  readOnlyView(): JobLocationView {
    return {
      time: this.time,
      currentFingerprint: this.currentFingerprint,
      read: (jobId) => this.read(jobId),
      observePoll: (read, liveJobIds) => this.observePoll(read, liveJobIds),
      resultPathFor: (jobId, execution) => this.resultPathFor(jobId, execution),
      unknownLocationHolds: () => this.unknownLocationHolds(),
      readHistorical: (epochKey, jobIds, session, fullHistory) =>
        this.readHistorical(epochKey, jobIds, session, fullHistory),
      historicalSourceState: (epochKey) => this.historicalSourceState(epochKey),
    };
  }

  register(
    jobId: string,
    epochKey: string,
    subject: JobLocationSubject,
    controller?: JobLocationController,
    observation?: RecoveryObservation,
  ): JobLocation {
    return this.withRevisionLock(epochKey, () => {
      const existing = this.readStored(jobId, observation);
      if (existing !== null) {
        if (!sameEpoch(existing.epochKey, epochKey)) throw new Error(`Job ${jobId} already belongs to another epoch`);
        return viewLocation(existing);
      }
      this.advanceRevision(epochKey);
      const location: StoredJobLocation = {
        version: 'v1',
        jobId,
        epochKey,
        subject,
        ...(controller === undefined ? {} : { controller }),
        disposition: 'active-owner',
      };
      atomicJson(this.runtime, this.jobPath(jobId), location);
      return viewLocation(location);
    });
  }

  withAdmissionGuard<T>(
    epochKey: string,
    db: Database,
    action: () => T,
    observation?: RecoveryObservation,
    jobIds?: readonly string[],
  ): T {
    if (this.heldEpoch !== null && sameEpoch(this.heldEpoch, epochKey)) return action();
    return this.withRevisionLock(epochKey, () => {
      const previous = this.heldEpoch;
      this.heldEpoch = epochKey;
      try {
        this.reconcileAdmissions(epochKey, db, observation, jobIds);
        let result: T;
        try {
          result = action();
        } catch (error: unknown) {
          try {
            this.reconcileAdmissions(epochKey, db, observation, jobIds);
          } catch (reconcileError: unknown) {
            this.recordAdmissionReconciliationFailure(epochKey, 'Admission rollback', reconcileError);
          }
          throw error;
        }
        try {
          this.reconcileAdmissions(epochKey, db, observation, jobIds);
        } catch (error: unknown) {
          this.recordAdmissionReconciliationFailure(epochKey, 'Committed admission refresh', error);
        }
        return result;
      } finally {
        this.heldEpoch = previous;
      }
    });
  }

  private recordAdmissionReconciliationFailure(epochKey: string, stage: string, error: unknown): void {
    const reason = `${stage} awaits location recovery: ${String(error)}`;
    try {
      this.holdUnknownLocations(epochKey, reason, false);
    } catch (holdError: unknown) {
      backendLog.warn(
        `${reason}; location hold unavailable: ${String(holdError)}; successor=admission reconciliation.`,
      );
    }
  }

  reconcileAdmissions(
    epochKey: string,
    db: Database,
    observation?: RecoveryObservation,
    jobIds?: readonly string[],
  ): void {
    this.withRevisionLock(epochKey, () => {
      const locations =
        jobIds === undefined
          ? this.locationsFor(epochKey, observation)
          : jobIds.flatMap((jobId) => {
              const location = this.read(jobId, observation);
              return location !== null && sameEpoch(location.epochKey, epochKey) ? [location] : [];
            });
      for (const location of locations) {
        if (location.pendingAdmission === undefined) continue;
        const current = this.readStored(location.jobId, observation);
        const pending = current?.pendingAdmission;
        if (current === null || pending === undefined) continue;
        const request = db
          .prepare<
            [string, number],
            { seq: number }
          >("SELECT seq FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
          .get(current.jobId, pending.execution);
        const { pendingAdmission: _pending, openExecution: _open, ...identity } = current;
        this.advanceRevision(epochKey);
        atomicJson(this.runtime, this.jobPath(current.jobId), {
          ...identity,
          ...(request === undefined
            ? { disposition: pending.priorTerminalSeq === undefined ? 'active-owner' : 'terminal' }
            : { disposition: 'active-owner', latestExecution: pending.execution, openExecution: pending.execution }),
        });
      }
    });
  }

  prepareAdmission(
    jobId: string,
    execution: number,
    epochKey: string,
    subject: JobLocationSubject,
    controller?: JobLocationController,
  ): void {
    if (this.heldEpoch === null || !sameEpoch(this.heldEpoch, epochKey))
      throw new Error('Job admission requires the location guard before the journal transaction.');
    this.register(jobId, epochKey, subject, controller);
    const current = this.readStored(jobId);
    if (current === null) throw new Error('Job admission has no location.');
    this.advanceRevision(epochKey);
    atomicJson(this.runtime, this.jobPath(jobId), {
      ...current,
      disposition: 'active-owner',
      pendingAdmission: {
        execution,
        ...(current.terminalSeq === undefined ? {} : { priorTerminalSeq: current.terminalSeq }),
      },
    });
  }

  beforeAppend(
    input: ResolvableCoralEventInput<unknown, unknown>,
    epochKey: string,
    _controller?: JobLocationController,
  ): void {
    if (input.stream.kind !== 'job' || (input.type !== 'job.opened' && input.type !== 'job.execution.requested'))
      return;
    if (this.heldEpoch === null || !sameEpoch(this.heldEpoch, epochKey))
      throw new Error('Job admission requires the location guard before the journal transaction.');
    const current = this.readStored(input.stream.id);
    const execution = input.type === 'job.opened' ? 1 : jobExecutionRequestedBodySchema.parse(input.body).execution;
    if (current === null || !sameEpoch(current.epochKey, epochKey) || current.pendingAdmission?.execution !== execution)
      throw new Error('Job admission was not durably prepared before the journal transaction.');
  }

  invalidateTerminalCertificate(epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      this.advanceRevision(epochKey);
    });
  }

  /** A terminal is recorded only when the copies its detail carries agree; readers trust the record after that. */
  recordTerminal(
    jobId: string,
    detail: JobDetailResponse,
    resultPath: string,
    terminalSeq: number,
    observation?: RecoveryObservation,
  ): JobLocation {
    detail = durableJobDetail(detail);
    const existing = this.readStored(jobId, observation);
    if (existing === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
    const terminal = validatedTerminal(detail, jobId, existing.epochKey, terminalSeq);
    if (terminal === null) throw new Error(`Terminal detail disagrees: ${jobId}`);
    return this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId, observation);
      if (current === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
      const location: StoredJobLocation = {
        ...current,
        subject: {
          ...current.subject,
          projectRoot: detail.status.projectRoot,
          workDir: detail.status.workDir,
          jobKind: detail.status.jobKind,
        },
        disposition: 'terminal',
        terminalSeq,
        resultPath,
        detail: preserveStoredDetail(current.detail, { ...detail, events: [terminal] }),
      };
      if (!isDeepStrictEqual(current, location)) {
        atomicJson(this.runtime, this.jobPath(jobId), location);
        this.advanceRevision(current.epochKey);
      }
      return viewLocation(location);
    });
  }

  recordExecutionDetails(
    jobId: string,
    entries: readonly JobExecutionLocation[],
    latest: JobDetailResponse,
    observation?: RecoveryObservation,
  ): JobLocation {
    const parsedEntries = entries.map((entry) =>
      storedExecutionSchema.parse({ ...entry, detail: durableJobDetail(entry.detail) }),
    );
    latest = durableJobDetail(latest);
    const existing = this.readStored(jobId, observation);
    if (existing === null) throw new Error(`Execution has no durable job location: ${jobId}`);
    for (const entry of parsedEntries) {
      if (
        entry.detail.status.execution !== entry.execution ||
        entry.requestedSeq >= entry.seq ||
        validatedTerminal(entry.detail, jobId, existing.epochKey, entry.seq, entry) === null
      )
        throw new Error(`Execution detail disagrees: ${jobId}#${entry.execution}`);
    }
    return this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId, observation);
      if (current === null) throw new Error(`Execution has no durable job location: ${jobId}`);
      const byExecution = new Map((current.executions ?? []).map((entry) => [entry.execution, entry]));
      for (const entry of parsedEntries) {
        const previous = byExecution.get(entry.execution);
        if (previous !== undefined && (previous.seq !== entry.seq || previous.requestedSeq !== entry.requestedSeq))
          throw new Error(`Execution boundary changed: ${jobId}#${entry.execution}`);
        byExecution.set(entry.execution, {
          ...previous,
          ...entry,
          detail: preserveStoredDetail(previous?.detail, entry.detail),
        });
      }
      const executions = [...byExecution.values()].sort((a, b) => a.execution - b.execution);
      if (
        executions.some(
          (entry, index) =>
            entry.execution !== index + 1 || (index > 0 && executions[index - 1].seq >= entry.requestedSeq),
        )
      )
        throw new Error(`Execution boundaries disagree: ${jobId}`);
      const terminal = executions.at(-1);
      const latestExecution = Math.max(current.latestExecution ?? 0, latest.status.execution ?? 0);
      const ended = terminal !== undefined && terminal.execution === latestExecution;
      const { openExecution: _open, ...identity } = current;
      const location: StoredJobLocation = {
        ...identity,
        disposition: ended && current.pendingAdmission === undefined ? 'terminal' : 'active-owner',
        executions,
        ...(latestExecution === 0 ? {} : { latestExecution }),
        ...(!ended && latestExecution > 0 ? { openExecution: latestExecution } : {}),
        ...(terminal === undefined
          ? { detail: preserveStoredDetail(current.detail, latest) }
          : {
              terminalSeq: terminal.seq,
              resultPath: terminal.resultPath,
              detail: preserveStoredDetail(current.terminalSeq === terminal.seq ? current.detail : undefined, {
                ...terminal.detail,
                events: terminal.detail.events.filter((event) => event.type === 'terminal'),
              }),
            }),
      };
      if (!isDeepStrictEqual(current, location)) {
        atomicJson(this.runtime, this.jobPath(jobId), location);
        this.advanceRevision(current.epochKey);
      }
      return viewLocation(location);
    });
  }

  execution(jobId: string, execution: number): JobExecutionLocation | null {
    return this.read(jobId)?.executions?.find((entry) => entry.execution === execution) ?? null;
  }

  recordObserved(jobId: string, detail: JobDetailResponse, observation?: RecoveryObservation): void {
    detail = durableJobDetail(detail);
    const existing = this.readStored(jobId, observation);
    if (existing === null) return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId, observation);
      if (current === null) return;
      const entry =
        detail.status.execution === null
          ? undefined
          : current.executions?.find((entry) => entry.execution === detail.status.execution);
      if (entry !== undefined) {
        const selected = {
          ...detail,
          events: detail.events.filter((event) => event.seq > entry.requestedSeq && event.seq <= entry.seq),
        };
        this.recordExecutionDetails(jobId, [{ ...entry, detail: selected }], selected);
        return;
      }
      if (current.terminalSeq !== undefined) return;
      const previous = current.detail as
        | { status?: { execution?: number | null }; events?: JobDetailResponse['events'] }
        | undefined;
      const events =
        previous?.status?.execution === detail.status.execution
          ? [
              ...new Map([...(previous.events ?? []), ...detail.events].map((event) => [event.seq, event])).values(),
            ].sort((a, b) => a.seq - b.seq)
          : detail.events;
      const next = { ...current, detail: preserveStoredDetail(current.detail, { ...detail, events }) };
      if (!isDeepStrictEqual(current, next)) atomicJson(this.runtime, this.jobPath(jobId), next);
    });
  }

  markUnresolved(jobId: string, observation?: RecoveryObservation): void {
    const existing = this.readStored(jobId, observation);
    if (existing === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
    if (existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId, observation);
      if (current === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
      if (current.disposition === 'terminal' || current.disposition === 'unresolved') return;
      this.advanceRevision(current.epochKey);
      atomicJson(this.runtime, this.jobPath(jobId), { ...current, disposition: 'unresolved' });
    });
  }

  markUncertified(jobId: string): void {
    const existing = this.read(jobId);
    if (existing === null) throw new Error(`Uncertified job has no durable location: ${jobId}`);
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
      if (current === null) throw new Error(`Uncertified job has no durable location: ${jobId}`);
      this.advanceRevision(current.epochKey);
      const { terminalSeq: _terminalSeq, resultPath: _resultPath, detail: _detail, ...identity } = current;
      atomicJson(this.runtime, this.jobPath(jobId), { ...identity, disposition: 'unresolved' });
    });
  }

  /**
   * The caller must hold the epoch store write lock while proving no launch event exists; without it, a launch may
   * still be in flight.
   */
  retireNeverAccepted(jobId: string, epochKey: string, observation?: RecoveryObservation): void {
    this.withRevisionLock(epochKey, () => {
      const current = this.readStored(jobId, observation);
      if (current === null || !sameEpoch(current.epochKey, epochKey) || current.disposition === 'terminal') return;
      this.runtime.storage.unlinkSync(this.jobPath(jobId));
      this.advanceRevision(epochKey);
      if (!this.runtime.storage.syncDirectoryDurableSync(dirname(this.jobPath(jobId)))) {
        throw new Error(`Could not sync job location directory: ${dirname(this.jobPath(jobId))}`);
      }
    });
  }

  holdUnknownLocations(epochKey: string, reason: string, retryScheduled = false): void {
    this.withRevisionLock(epochKey, () => {
      const path = join(this.root, 'epochs', epochHoldDirectory(epochKey), 'unknown-locations.v1.json');
      const previous = optionalJson(this.runtime, path, unknownHoldSchema);
      if (previous?.reason === reason && previous.retryScheduled === retryScheduled) return;
      this.advanceRevision(epochKey);
      atomicJson(this.runtime, path, { ...previous, version: 'v1', epochKey, reason, retryScheduled });
    });
  }

  clearUnknownLocations(epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      const ownedPath = join(this.root, 'epochs', epochHoldDirectory(epochKey), 'unknown-locations.v1.json');
      const alias = this.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey));
      const path = this.runtime.storage.existsSync(ownedPath)
        ? ownedPath
        : alias?.epochKey
          ? join(this.root, 'epochs', epochHoldDirectory(alias.epochKey), 'unknown-locations.v1.json')
          : this.epochPath(epochKey, 'unknown-locations.v1.json');
      if (!this.runtime.storage.existsSync(path)) return;
      this.runtime.storage.unlinkSync(path);
      this.advanceRevision(epochKey);
      if (!this.runtime.storage.syncDirectoryDurableSync(dirname(path))) {
        throw new Error(`Could not sync job location directory: ${dirname(path)}`);
      }
    });
  }

  private readUnknownLocationHold(path: string, identity: string, directory = false): UnknownLocationHold | null {
    try {
      const hold = optionalJson(this.runtime, path, unknownHoldSchema);
      if (hold === null) return null;
      if (hold.retryScheduled === undefined) {
        // A v0.10.16-18 hold names neither its key nor a retry; a present epoch's registered source still retries it.
        const owner = registeredHistoricalEpoch(this, directory ? identity : epochHoldDirectory(identity));
        if (owner !== undefined && this.historicalSourceState(owner) === 'present')
          return { epochKey: owner, reason: hold.reason, retryScheduled: true };
      }
      return {
        ...(hold.epochKey ? { epochKey: hold.epochKey } : directory ? { directory: identity } : { epochKey: identity }),
        reason: hold.reason,
        retryScheduled: hold.retryScheduled === true,
      };
    } catch (error) {
      // Every hold lives in a directory: a stray file under epochs/ holds nothing, and as a hold it could never clear.
      if (directory && error instanceof Error && 'code' in error && error.code === 'ENOTDIR') {
        if (!this.strayEpochEntryReported)
          backendLog.warn(`[job-locations] ignoring non-directory entry under epochs/: ${identity}`);
        this.strayEpochEntryReported = true;
        return null;
      }
      return {
        ...(directory ? { directory: identity } : { epochKey: identity }),
        reason: 'Location recovery hold cannot be decoded or read by this build; no automatic retry is scheduled',
        retryScheduled: false,
      };
    }
  }

  /** Whether this exact key owns a hold file; answering it takes no lock and creates nothing. */
  ownsUnknownLocationHold(epochKey: string): boolean {
    return this.runtime.storage.existsSync(
      join(this.root, 'epochs', epochHoldDirectory(epochKey), 'unknown-locations.v1.json'),
    );
  }

  unknownLocationHold(epochKey: string): string | null {
    const ownedPath = join(this.root, 'epochs', epochHoldDirectory(epochKey), 'unknown-locations.v1.json');
    if (this.runtime.storage.existsSync(ownedPath))
      return this.readUnknownLocationHold(ownedPath, epochKey)?.reason ?? null;
    return this.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.reason ?? null;
  }

  unknownLocationHolds(): UnknownLocationHold[] {
    const root = join(this.root, 'epochs');
    if (!this.runtime.storage.existsSync(root)) return [];
    return this.runtime.storage
      .readdirSync(root)
      .flatMap((key) => {
        const hold = this.readUnknownLocationHold(join(root, key, 'unknown-locations.v1.json'), key, true);
        return hold ? [hold] : [];
      })
      .sort((a, b) => Number(a.retryScheduled) - Number(b.retryScheduled));
  }

  reconcileUnknownLocationHolds(presentKeys: readonly string[], inventoryComplete = true): void {
    for (const hold of this.unknownLocationHolds()) {
      try {
        const present = presentKeys.find((key) => sameEpoch(key, hold.epochKey ?? { directory: hold.directory }));
        if (present || !inventoryComplete) continue;
        if (hold.epochKey === undefined) {
          if (!inventoryComplete) continue;
          const scan = this.scan();
          if (
            scan.unreadable.length > 0 ||
            scan.readable.some(
              (location) =>
                sameEpoch(location.epochKey, { directory: hold.directory }) && !hasReadableTerminalDetail(location),
            )
          )
            continue;
          this.runtime.storage.rmSync(join(this.root, 'epochs', hold.directory, 'unknown-locations.v1.json'), {
            force: true,
          });
          continue;
        }
        if (
          hold.epochKey !== undefined &&
          (this.certificate(hold.epochKey) || this.locationsFor(hold.epochKey).every(hasReadableTerminalDetail))
        ) {
          this.clearUnknownLocations(hold.epochKey);
          continue;
        }
        if (hold.epochKey !== undefined && this.historicalSourceState(hold.epochKey) !== 'absent') continue;
        const reason = 'Source retired; no further source read is possible';
        this.holdUnknownLocations(hold.epochKey, reason, false);
      } catch {
        // Keep the durable hold when its revision or certificate cannot be observed.
        continue;
      }
    }
  }

  /**
   * Records this build cannot decode must be reported by file and epoch, or with null when even the epoch is
   * unreadable.
   */
  private scan(observation?: RecoveryObservation): {
    readable: JobLocation[];
    unreadable: Array<{ file: string; epochKey: string | null }>;
  } {
    const dir = join(this.root, 'jobs');
    const result: ReturnType<JobLocationIndex['scan']> = { readable: [], unreadable: [] };
    if (!this.runtime.storage.existsSync(dir)) return result;
    for (const name of this.runtime.storage.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      let raw: unknown;
      try {
        const content = this.runtime.storage.readFileSync(join(dir, name), 'utf-8');
        observation?.record('job-locations', { reads: 1 });
        raw = JSON.parse(content) as unknown;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        result.unreadable.push({ file: name, epochKey: null });
        continue;
      }
      const parsed = locationSchema.safeParse(raw);
      if (parsed.success) {
        result.readable.push(viewLocation(parsed.data));
        continue;
      }
      const named = z.object({ epochKey: z.string().min(1) }).safeParse(raw);
      result.unreadable.push({ file: name, epochKey: named.success ? named.data.epochKey : null });
    }
    return result;
  }

  *jobIds(): IterableIterator<string> {
    const dir = join(this.root, 'jobs');
    if (!this.runtime.storage.existsSync(dir)) return;
    for (const name of this.runtime.storage.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const encoded = name.slice(0, -5);
      const jobId = Buffer.from(encoded, 'base64url').toString('utf8');
      if (Buffer.from(jobId).toString('base64url') === encoded) yield jobId;
    }
  }

  locations(): JobLocation[] {
    return this.scan().readable;
  }

  revision(epochKey: string): number {
    return optionalJson(this.runtime, this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
  }

  locationsFor(epochKey: string, observation?: RecoveryObservation): JobLocation[] {
    const revision = this.revision(epochKey);
    if (this.epochRevisions.get(epochKey) !== revision) this.locationsStamp = undefined;
    this.epochRevisions.set(epochKey, revision);
    const dir = join(this.root, 'jobs');
    const stat = this.runtime.storage.existsSync(dir) ? this.runtime.storage.lstatSync(dir, { bigint: true }) : null;
    const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}` : 'absent';
    if (this.locationsStamp !== stamp) {
      this.locationsByEpoch.clear();
      const scan = this.scan(observation);
      this.locationsUnreadable = scan.unreadable;
      for (const location of scan.readable) {
        const locations = this.locationsByEpoch.get(epochIdentity(location.epochKey)) ?? [];
        locations.push(location);
        this.locationsByEpoch.set(epochIdentity(location.epochKey), locations);
      }
      this.locationsStamp = stamp;
    }
    return (this.locationsByEpoch.get(epochIdentity(epochKey)) ?? []).map(
      (location) => this.read(location.jobId, observation) ?? location,
    );
  }

  certify(
    epochKey: string,
    terminalHighWaterSeq: number,
    observation?: RecoveryObservation,
  ): JobLocationCertificate | null {
    return this.withRevisionLock(epochKey, () => {
      const locations = this.locationsFor(epochKey, observation);
      if (this.unknownLocationHold(epochKey) !== null) return null;
      if (this.locationsUnreadable.some((entry) => entry.epochKey === null || sameEpoch(entry.epochKey, epochKey)))
        return null;
      if (
        locations.some(
          (location) =>
            !hasReadableTerminalDetail(location) ||
            location.pendingAdmission !== undefined ||
            location.openExecution !== undefined ||
            (location.executions !== undefined && location.executions.length !== location.latestExecution),
        )
      ) {
        return null;
      }
      const revision =
        optionalJson(this.runtime, this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
      const previous = optionalJson(this.runtime, this.epochPath(epochKey, 'certificate.v1.json'), certificateSchema);
      const certificate = certificateSchema.parse({
        ...previous,
        version: 'v1',
        epochKey,
        revision,
        jobIds: locations.map((location) => location.jobId).sort(),
        terminalHighWaterSeq,
      });
      if (!isDeepStrictEqual(previous, certificate))
        atomicJson(this.runtime, this.epochPath(epochKey, 'certificate.v1.json'), certificate);
      return certificate;
    });
  }

  certificate(epochKey: string): JobLocationCertificate | null {
    const path = this.epochPath(epochKey, 'certificate.v1.json');
    const stat = this.runtime.storage.existsSync(path) ? this.runtime.storage.lstatSync(path, { bigint: true }) : null;
    const stamp = stat
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`
      : 'absent';
    let cached = this.certificates.get(epochKey);
    if (cached?.stamp !== stamp) {
      cached = { stamp, value: optionalJson(this.runtime, path, certificateSchema) };
      this.certificates.set(epochKey, cached);
    }
    const certificate = cached.value;
    const revision =
      optionalJson(this.runtime, this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
    return certificate?.revision === revision ? certificate : null;
  }

  /**
   * A record that cannot be read proves nothing, so release then stays unproven rather than failing its caller. Forces
   * on the calling thread.
   */
  resultsReleased(epochKey: string, closedSource?: ResolvedStoreEpoch): boolean {
    try {
      const certificate = this.withRevisionLock(epochKey, () => this.certificate(epochKey));
      if (certificate === null) return false;
      const prove = (plan: ReleasePlan): boolean => {
        try {
          return proveResultArtifactsDurable(this.runtime.storage, plan.artifacts, this.jobsRoot);
        } catch {
          return false;
        }
      };
      const remembered = this.takeRememberedReleasePlan(epochKey, certificate, closedSource);
      if (remembered !== null && prove(remembered)) return this.confirmRelease(epochKey, certificate, remembered);
      const plan = this.planRelease(epochKey, certificate.jobIds, closedSource);
      return plan !== null && prove(plan) && this.confirmRelease(epochKey, certificate, plan);
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      return false;
    }
  }

  /** Every force is awaited off the event loop. */
  async resultsReleasedAsync(
    epochKey: string,
    signal: AbortSignal,
    closedSource?: ResolvedStoreEpoch,
  ): Promise<boolean> {
    try {
      const certificate = this.withRevisionLock(epochKey, () => this.certificate(epochKey));
      if (certificate === null) return false;
      const prove = async (plan: ReleasePlan): Promise<boolean> => {
        try {
          return await proveResultArtifactsDurableAsync(this.runtime.storage, plan.artifacts, this.jobsRoot, signal);
        } catch {
          return false;
        }
      };
      const remembered = this.takeRememberedReleasePlan(epochKey, certificate, closedSource);
      if (remembered !== null && (await prove(remembered)))
        return this.confirmRelease(epochKey, certificate, remembered);
      const plan = await this.planReleaseYielding(epochKey, certificate.jobIds, signal, closedSource);
      return plan !== null && (await prove(plan)) && this.confirmRelease(epochKey, certificate, plan);
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      return false;
    }
  }

  /** Planning and forcing run unlocked, so release holds only if the certificate they began from is still current. */
  private confirmRelease(epochKey: string, certificate: JobLocationCertificate, plan: ReleasePlan): boolean {
    return this.withRevisionLock(epochKey, () => {
      if (this.certificate(epochKey)?.revision !== certificate.revision) return false;
      if (plan.locations !== null)
        this.releasePlans.set(epochIdentity(epochKey), {
          ...plan,
          revision: certificate.revision,
          locations: plan.locations,
        });
      return true;
    });
  }

  /**
   * Taking a plan forgets it until `confirmRelease` remembers it again. A record rewritten without advancing its
   * epoch's revision, such as one no longer readable, or a refuted source the plan read from invalidates it.
   */
  private takeRememberedReleasePlan(
    epochKey: string,
    certificate: JobLocationCertificate,
    closedSource?: ResolvedStoreEpoch,
  ): ReleasePlan | null {
    const remembered = this.releasePlans.get(epochIdentity(epochKey));
    this.releasePlans.delete(epochIdentity(epochKey));
    if (remembered?.revision !== certificate.revision) return null;
    for (const [jobId, stamp] of remembered.locations) if (this.locationStamp(jobId) !== stamp) return null;
    if (remembered.fromSource && !this.sourceConfirmed(epochKey, closedSource)) return null;
    return remembered;
  }

  private sourceConfirmed(epochKey: string, closedSource?: ResolvedStoreEpoch): boolean {
    try {
      return withTerminalSource(this.runtime, epochKey, () => true, closedSource) === true;
    } catch {
      return false;
    }
  }

  /** Null when the record's stat cannot show it unchanged. */
  private locationStamp(jobId: string): string | null {
    try {
      const stat = this.runtime.storage.lstatSync(this.jobPath(jobId), { bigint: true });
      return stat.ctimeNs === undefined ? null : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return null;
    }
  }

  private async planReleaseYielding(
    epochKey: string,
    jobIds: readonly string[],
    signal: AbortSignal,
    closedSource?: ResolvedStoreEpoch,
  ): Promise<ReleasePlan | null> {
    const artifacts: string[] = [];
    const locations = new Map<string, string>();
    let stamped = true;
    let fromSource = false;
    for (let start = 0; start < jobIds.length; start += RELEASE_PLAN_BATCH) {
      const batch = this.planRelease(epochKey, jobIds.slice(start, start + RELEASE_PLAN_BATCH), closedSource);
      if (batch === null) return null;
      artifacts.push(...batch.artifacts);
      if (batch.locations === null) stamped = false;
      else for (const [jobId, stamp] of batch.locations) locations.set(jobId, stamp);
      fromSource ||= batch.fromSource;
      await setImmediate();
      if (signal.aborted) return null;
    }
    return { artifacts, locations: stamped ? locations : null, fromSource };
  }

  /** Each record is stamped before it is read, so any later change to it is visible to the stamp. */
  private planRelease(
    epochKey: string,
    jobIds: readonly string[],
    closedSource?: ResolvedStoreEpoch,
  ): ReleasePlan | null {
    const plan = (source: Database | null): ReleasePlan | null => {
      const artifacts: string[] = [];
      let locations: Map<string, string> | null = new Map();
      for (const jobId of jobIds) {
        const stamp = this.locationStamp(jobId);
        if (stamp === null) locations = null;
        else locations?.set(jobId, stamp);
        const job = this.releaseArtifacts(jobId, source);
        if (job === null) return null;
        artifacts.push(...job);
      }
      return { artifacts, locations, fromSource: source !== null };
    };
    try {
      return withTerminalSource(this.runtime, epochKey, plan, closedSource) ?? plan(null);
    } catch {
      return plan(null);
    }
  }

  /**
   * Proves the retained artifact for one job independently of other jobs in its epoch: a known expired age, read from
   * the job's intact source, discharges it without a file; anything else needs a durable nonempty file.
   */
  resultDurable(jobId: string, source?: Database | null): boolean {
    const artifacts = this.releaseArtifacts(jobId, source);
    try {
      return artifacts !== null && proveResultArtifactsDurable(this.runtime.storage, artifacts, this.jobsRoot);
    } catch {
      return false;
    }
  }

  private releaseArtifacts(jobId: string, source?: Database | null): readonly string[] | null {
    const location = this.read(jobId);
    if (
      location === null ||
      location.pendingAdmission !== undefined ||
      location.openExecution !== undefined ||
      !hasReadableTerminalDetail(location)
    ) {
      return null;
    }
    if (location.executions !== undefined) {
      try {
        return source === undefined
          ? (withTerminalSource(this.runtime, location.epochKey, (db) =>
              currentResultArtifacts(this.runtime, location, db),
            ) ?? currentResultArtifacts(this.runtime, location, null))
          : currentResultArtifacts(this.runtime, location, source);
      } catch {
        return null;
      }
    }
    const eligibility =
      source === undefined
        ? this.terminalEligibility(jobId)
        : this.sourceEligibility(location, (read) => (source === null ? null : read(source)));
    if (eligibility.age === 'expired') return [];
    return location.resultPath === undefined ? null : [location.resultPath];
  }

  resultPathFor(jobId: string, execution: number): string {
    return resultPathFor(this.runtime.paths.coral.exports.jobsRoot, jobId, execution);
  }

  resultExportOwnerForSource(db: Database, epochKey: string, jobsRoot: string): TerminalResultExportOwner {
    const ctx = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
    return new TerminalResultExportOwner({
      runtime: this.runtime,
      jobsRoot,
      workflowReport: this.workflowReport,
      failures: this.resultRepairFailures,
      repairScope: this,
      hydrationRetry: () =>
        this.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, epochKey))?.retryScheduled,
      readTerminalInput: (source, jobId, execution) => retainedResultInput(this, epochKey, source, jobId, execution),
      prepareTerminal: (jobId, source) => this.prepareTerminal(jobId, source, epochKey, jobsRoot),
      location: (jobId) => this.read(jobId),
      withSource: (jobId, read, location) => {
        if (!sameEpoch((location ?? this.read(jobId))?.epochKey, epochKey))
          throw new Error('Source epoch identity cannot be confirmed');
        return read(db, ctx);
      },
    });
  }

  prepareTerminal(jobId: string, db: Database, epochKey: string, jobsRoot: string): void {
    const current = this.read(jobId);
    if (!current || !sameEpoch(current.epochKey, epochKey) || hasReadableTerminalDetail(current)) return;
    prepareRetainedJob(this, db, epochKey, jobId, jobsRoot, this.runtime);
  }

  private sourceEligibility(
    location: JobLocation | null,
    withSource: <T>(read: (db: Database) => T) => T | null,
  ): TerminalEligibility {
    if (location === null) return { source: 'unusable', age: 'unknown' };
    try {
      const input = withSource((db) => retainedResultInput(this, location.epochKey, db, location.jobId));
      if (input === null) return { source: 'absent', age: 'unknown' };
      const terminal =
        location.detail.kind === 'recorded'
          ? location.detail.value.events.find(
              (event) => event.type === 'terminal' && event.seq === location.terminalSeq,
            )
          : undefined;
      if (terminal === undefined || terminal.seq !== input.accepted.seq || terminal.ts !== input.accepted.ts)
        return { source: 'unusable', age: 'unknown' };
      return {
        source: 'readable',
        age:
          typeof input.age !== 'number'
            ? 'unknown'
            : input.age < jobRetentionCutoff(this.runtime)
              ? 'expired'
              : 'inside',
      };
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      return {
        source: sourceReadFailureDisposition(error) === 'transient-unknown' ? 'transient' : 'unusable',
        age: 'unknown',
      };
    }
  }

  terminalEligibility(jobId: string): TerminalEligibility {
    const location = this.read(jobId);
    return this.sourceEligibility(location, (read) => {
      if (location === null) return null;
      return withTerminalSource(this.runtime, location.epochKey, read);
    });
  }

  exportResultRetention(jobId: string, activeEpochKey: string | null): 'released' | 'required' | 'unknown' {
    try {
      const location = this.read(jobId);
      if (location === null) {
        if (observeStorePath(this.runtime.storage, this.jobPath(jobId)) !== 'absent') return 'unknown';
        return 'released';
      }
      if (sameEpoch(location.epochKey, activeEpochKey)) return 'released';
      const epoch = observeResolvedStoreEpoch(this.runtime, location.epochKey);
      if (epoch === undefined) return 'unknown';
      const storeRoot = epoch.canonicalStoreRoot ?? epoch.storeRoot;
      const paths = [dirname(epoch.path), join(storeRoot, `epoch-${epoch.epoch}`)];
      if (epoch.lineageKey === undefined) paths.push(protectedStoreEpochRoot(storeRoot));
      else {
        if (!/^[0-9a-f-]{36}:[1-9]\d*$/u.test(epoch.lineageKey)) return 'unknown';
        const lineageRoot = join(protectedStoreEpochRoot(storeRoot), epoch.lineageKey.split(':')[0]);
        paths.push(join(lineageRoot, `epoch-${epoch.epoch}`), join(lineageRoot, `.reaping-epoch-${epoch.epoch}`));
      }
      const observations = paths.map((path) => observeStorePath(this.runtime.storage, path));
      return observations.every((observation) => observation === 'absent') ? 'released' : 'required';
    } catch {
      return 'unknown';
    }
  }

  async compactTerminalRecords(
    afterId: string,
    budget: RetentionRunBudget,
    mutate: <T>(operation: () => T) => T,
    checkpoint: (id: string) => void = () => {},
  ): Promise<string> {
    const dir = join(this.root, 'jobs');
    if (!this.runtime.storage.existsSync(dir)) return '';
    let cursor = afterId;
    const names = this.runtime.storage.readdirSync(dir).sort();
    budget.observation?.record('job-locations', {
      subjects: names.filter((name) => name.endsWith('.json')).length,
    });
    for (const name of names) {
      if (!name.endsWith('.json') || name <= afterId) continue;
      if (!budget.canContinue()) return cursor;
      const refusalPath = join(this.root, 'compaction-refusals.v1', name);
      try {
        const stored = optionalJson(this.runtime, join(dir, name), locationSchema, budget.observation);
        const location = stored === null ? null : viewLocation(stored);
        if (location?.detail.kind === 'unreadable') throw new Error('location-detail-unreadable');
        if (
          location !== null &&
          hasReadableTerminalDetail(location) &&
          location.detail.kind === 'recorded' &&
          (location.detail.value.events.length > 1 ||
            location.executions?.some((entry) => entry.detail.events.length > 1))
        ) {
          mutate(() =>
            this.withRevisionLock(location.epochKey, () => {
              const current = optionalJson(this.runtime, join(dir, name), locationSchema, budget.observation);
              if (current === null) return;
              const location = viewLocation(current);
              if (!hasReadableTerminalDetail(location) || location.detail.kind !== 'recorded') return;
              const events = location.detail.value.events
                .filter(
                  (event) =>
                    event.type === 'terminal' && event.jobId === location.jobId && event.seq === location.terminalSeq,
                )
                .slice(0, 1);
              const detail = preserveStoredDetail(current.detail, { ...location.detail.value, events });
              const executions = current.executions?.map((entry) => ({
                ...entry,
                detail: preserveStoredDetail(entry.detail, {
                  ...entry.detail,
                  events: entry.detail.events.filter((event) => event.type === 'terminal' && event.seq === entry.seq),
                }),
              }));
              const next = { ...current, detail, ...(executions === undefined ? {} : { executions }) };
              if (!isDeepStrictEqual(current, next)) atomicJson(this.runtime, join(dir, name), next);
            }),
          );
        }
        if (this.runtime.storage.existsSync(refusalPath))
          mutate(() => {
            this.runtime.storage.unlinkSync(refusalPath);
            if (!this.runtime.storage.syncDirectoryDurableSync(dirname(refusalPath)))
              throw new Error('location-refusal-clear-sync-failed');
          });
      } catch (error: unknown) {
        const reason = `location-compaction-held: ${String(error)}; daily retry clears refusal after readable evidence returns`;
        mutate(() => {
          const refusal = { version: 'v1' as const, reason };
          let previous: unknown = null;
          try {
            previous = optionalJson(this.runtime, refusalPath, unknownHoldSchema);
          } catch {
            // A damaged refusal is replaced by the current refusal for this identity.
          }
          if (!isDeepStrictEqual(previous, refusal)) atomicJson(this.runtime, refusalPath, refusal);
        });
        budget.record({ kind: 'kept', subject: name, reason });
      }
      cursor = name;
      checkpoint(cursor);
      await setImmediate();
    }
    return '';
  }
}
