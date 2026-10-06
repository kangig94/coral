import { createHash } from 'node:crypto';
import { sameEpoch, epochHoldDirectory, epochIdentity } from '../store/epoch/identity.js';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { acquireDirectoryLockSync } from '../infra/fs-lock.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ResolvableCoralEventInput } from '../store/envelope.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import { usageSummarySchema } from '../providers/contract.js';
import { jobProgressTimingSchema } from './event-bodies.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { jobPhaseSchema } from './phase.js';
import { jobKindSchema, type JobDetailResponse, type JobKind } from './records.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';
import { type ResolvedStoreEpoch } from '../store/epoch/types.js';
import { observeResolvedStoreEpoch } from '../store/epoch/observation.js';
import { observeStorePath } from '../store/path-observation.js';
import { protectedStoreEpochRoot } from '../store/epoch/protection.js';
import {
  TerminalResultExportOwner,
  resultPathFor,
  resultRepairFailuresFor,
  type WorkflowReportPort,
} from './terminal/export.js';
import { hasReadableTerminalDetail, validatedTerminal } from './terminal/identity.js';
import { withTerminalSource } from './terminal/source.js';
import { isCodeDefect } from './source-read.js';
import { composeReducers } from '../store/reducers.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { jobsRegistry } from './events.js';
import type { Database } from '../store/db.js';
import { terminalEligibility, type TerminalEligibility } from './export-retention.js';
import {
  type HistoricalSourceRead,
  readHistoricalJobDetail,
  readHistoricalSource,
  registeredHistoricalEpoch,
  type HistoricalSourceReader,
} from './historical-reader.js';
import type { RetentionRunBudget } from '../store/retention-outcome.js';

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
const locationSchema = locationIdentitySchema.extend({ detail: z.unknown().optional() }).passthrough();
const jobEventBaseSchema = z.object({
  jobId: z.string(),
  sessionId: z.string().nullable(),
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
const storedJobDetailSchema: z.ZodType<JobDetailResponse, z.ZodTypeDef, unknown> = storedPassthrough(
  z
    .object({
      status: z
        .object({
          jobId: z.string().min(1),
          owner: executionOwnerSchema,
          sessionId: z.string().nullable(),
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
          phase: jobPhaseSchema,
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
      exit: jobTerminalSchema
        .extend({ diagnostics: jobDiagnosticsSchema, endTime: z.string() })
        .passthrough()
        .nullable(),
    })
    .passthrough(),
);
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

export type JobLocation = z.infer<typeof locationIdentitySchema> & { detail: JobLocationDetail };

export type UnknownLocationHold = Readonly<
  { reason: string; retryScheduled: boolean } & (
    | { epochKey: string; directory?: undefined }
    | { epochKey?: undefined; directory: string }
  )
>;

export class LocationObservationDeferred extends Error {}

export interface JobLocationView {
  readHistorical?: HistoricalSourceReader;
  historicalSourceState?(epochKey: string): 'present' | 'absent' | 'unobservable';
  readonly time: TimePort;
  read(jobId: string): JobLocation | null;
  observePoll?<T>(read: () => T, liveJobIds?: ReadonlySet<string>): T;
  resultPathFor(jobId: string): string;
  unknownLocationHolds(): UnknownLocationHold[];
}

function viewLocation(stored: StoredJobLocation): JobLocation {
  const { detail: raw, ...identity } = stored;
  if (raw === undefined) return { ...identity, detail: { kind: 'absent' } };
  const parsed = storedJobDetailSchema.safeParse(raw);
  if (!parsed.success) return { ...identity, detail: { kind: 'unreadable' } };
  const location: JobLocation = { ...identity, detail: { kind: 'recorded', value: parsed.data } };
  const terminalPresent =
    stored.disposition === 'terminal' ||
    parsed.data.exit !== null ||
    parsed.data.status.result !== undefined ||
    parsed.data.events.some((event) => event.type === 'terminal');
  return terminalPresent && !hasReadableTerminalDetail(location)
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

function optionalJson<T>(runtime: Runtime, path: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown);
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
  private locationsUnreadable: Array<{ file: string; epochKey: string | null }> = [];
  private readonly locationsByEpoch = new Map<string, JobLocation[]>();
  private readonly runtime: Runtime;

  readonly workflowReport?: WorkflowReportPort;

  constructor(runtime: Runtime, stateRoot: string, workflowReport?: WorkflowReportPort) {
    this.workflowReport = workflowReport;
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
  private withRevisionLock<T>(epochKey: string, action: () => T): T {
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
      return this.withDirectoryLock(this.epochPath(epochKey, 'revision.lock'), action);
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

  private readStored(jobId: string): StoredJobLocation | null {
    if (this.pollReads?.has(jobId)) return this.pollReads.get(jobId) ?? null;
    if (this.pollReads && !this.livePollJobs.has(jobId)) {
      if (this.pollReadCount >= 32)
        throw new LocationObservationDeferred('Location observation deferred to the next bounded poll');
      this.pollReadCount++;
    }
    const stored = optionalJson(this.runtime, this.jobPath(jobId), locationSchema);
    this.pollReads?.set(jobId, stored);
    return stored;
  }

  read(jobId: string): JobLocation | null {
    const stored = this.readStored(jobId);
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
      read: (jobId) => this.read(jobId),
      observePoll: (read, liveJobIds) => this.observePoll(read, liveJobIds),
      resultPathFor: (jobId) => this.resultPathFor(jobId),
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
  ): JobLocation {
    return this.withRevisionLock(epochKey, () => {
      const existing = this.readStored(jobId);
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

  beforeAppend(
    input: ResolvableCoralEventInput<unknown, unknown>,
    epochKey: string,
    controller?: JobLocationController,
  ): void {
    if (input.stream.kind !== 'job') return;
    if (input.type === 'job.launch.requested') {
      const launch = jobLaunchRequestBodySchema.parse(input.body);
      this.register(
        input.stream.id,
        epochKey,
        {
          projectRoot: launch.projectRoot,
          workDir: launch.jobKind === 'kb' ? null : launch.request.cwd,
          jobKind: launch.jobKind,
        },
        controller,
      );
    } else if (input.type === 'job.terminal.recorded') {
      this.invalidateTerminalCertificate(epochKey);
    }
  }

  invalidateTerminalCertificate(epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      this.advanceRevision(epochKey);
    });
  }

  /** A terminal is recorded only when the copies its detail carries agree; readers trust the record after that. */
  recordTerminal(jobId: string, detail: JobDetailResponse, resultPath: string, terminalSeq: number): JobLocation {
    const existing = this.readStored(jobId);
    if (existing === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
    const terminal = validatedTerminal(detail, jobId, existing.epochKey, terminalSeq);
    if (terminal === null) throw new Error(`Terminal detail disagrees: ${jobId}`);
    return this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
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

  recordObserved(jobId: string, detail: JobDetailResponse): void {
    const existing = this.read(jobId);
    if (existing === null || existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
      if (current === null || current.disposition === 'terminal') return;
      const retained = viewLocation(current);
      const location = {
        ...current,
        detail: preserveStoredDetail(current.detail, {
          ...detail,
          events: [
            ...new Map(
              [...(retained.detail.kind === 'recorded' ? retained.detail.value.events : []), ...detail.events].map(
                (event) => [`${event.seq}:${event.type}`, event],
              ),
            ).values(),
          ].sort((a, b) => a.seq - b.seq),
        }),
      };
      if (!isDeepStrictEqual(current, location)) {
        atomicJson(this.runtime, this.jobPath(jobId), location);
      }
    });
  }

  markUnresolved(jobId: string): void {
    const existing = this.readStored(jobId);
    if (existing === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
    if (existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
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
  retireNeverAccepted(jobId: string, epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      const current = this.readStored(jobId);
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
    } catch {
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
  private scan(): { readable: JobLocation[]; unreadable: Array<{ file: string; epochKey: string | null }> } {
    const dir = join(this.root, 'jobs');
    const result: ReturnType<JobLocationIndex['scan']> = { readable: [], unreadable: [] };
    if (!this.runtime.storage.existsSync(dir)) return result;
    for (const name of this.runtime.storage.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      let raw: unknown;
      try {
        raw = JSON.parse(this.runtime.storage.readFileSync(join(dir, name), 'utf-8')) as unknown;
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

  locationsFor(epochKey: string): JobLocation[] {
    const revision = this.revision(epochKey);
    if (this.epochRevisions.get(epochKey) !== revision) this.locationsStamp = undefined;
    this.epochRevisions.set(epochKey, revision);
    const dir = join(this.root, 'jobs');
    const stat = this.runtime.storage.existsSync(dir) ? this.runtime.storage.lstatSync(dir, { bigint: true }) : null;
    const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}` : 'absent';
    if (this.locationsStamp !== stamp) {
      this.locationsByEpoch.clear();
      const scan = this.scan();
      this.locationsUnreadable = scan.unreadable;
      for (const location of scan.readable) {
        const locations = this.locationsByEpoch.get(epochIdentity(location.epochKey)) ?? [];
        locations.push(location);
        this.locationsByEpoch.set(epochIdentity(location.epochKey), locations);
      }
      this.locationsStamp = stamp;
    }
    return (this.locationsByEpoch.get(epochIdentity(epochKey)) ?? []).map(
      (location) => this.read(location.jobId) ?? location,
    );
  }

  certify(epochKey: string, terminalHighWaterSeq: number): JobLocationCertificate | null {
    return this.withRevisionLock(epochKey, () => {
      const locations = this.locationsFor(epochKey);
      if (this.unknownLocationHold(epochKey) !== null) return null;
      if (this.locationsUnreadable.some((entry) => entry.epochKey === null || sameEpoch(entry.epochKey, epochKey)))
        return null;
      if (locations.some((location) => !hasReadableTerminalDetail(location))) {
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

  /** A record that cannot be read proves nothing, so release then stays unproven rather than failing its caller. */
  resultsReleased(epochKey: string, closedSource?: ResolvedStoreEpoch): boolean {
    try {
      const certificate = this.certificate(epochKey);
      if (certificate === null) return false;
      try {
        return (
          withTerminalSource(
            this.runtime,
            epochKey,
            (db) => certificate.jobIds.every((jobId) => this.resultDurable(jobId, db)),
            closedSource,
          ) ?? certificate.jobIds.every((jobId) => this.resultDurable(jobId, null))
        );
      } catch {
        return certificate.jobIds.every((jobId) => this.resultDurable(jobId, null));
      }
    } catch (error) {
      if (isCodeDefect(error)) throw error;
      return false;
    }
  }

  /**
   * Proves the retained artifact for one job independently of other jobs in its epoch: a known expired age, read from
   * the job's intact source, discharges it without a file; anything else needs a durable nonempty file.
   */
  resultDurable(jobId: string, source?: Database | null): boolean {
    const location = this.read(jobId);
    if (location === null || !hasReadableTerminalDetail(location)) {
      return false;
    }
    const eligibility =
      source === undefined
        ? this.terminalEligibility(jobId)
        : terminalEligibility(this.runtime, location, (read) => (source === null ? null : read(source)));
    if (eligibility.age === 'expired') return true;
    if (location.resultPath === undefined) return false;
    try {
      const fd = this.runtime.storage.openSync(location.resultPath, 'r');
      try {
        const artifact = this.runtime.storage.fstatSync(fd, { bigint: true });
        if (!artifact.isFile() || artifact.size === 0n) return false;
        this.runtime.storage.fdatasyncSync(fd);
        const directory = dirname(location.resultPath);
        return (
          this.runtime.storage.syncDirectoryDurableSync(directory) &&
          this.runtime.storage.syncDirectoryDurableSync(dirname(directory))
        );
      } finally {
        this.runtime.storage.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  resultPathFor(jobId: string): string {
    return resultPathFor(this.runtime.paths.coral.exports.jobsRoot, jobId);
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
      prepareTerminal: (jobId) => this.prepareTerminal(jobId, db, epochKey, jobsRoot),
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
    const detail = readHistoricalJobDetail(db, jobId);
    const terminal = detail?.events.find((event) => event.type === 'terminal');
    if (!detail?.exit || !terminal) return;
    this.recordTerminal(jobId, detail, current.resultPath ?? resultPathFor(jobsRoot, jobId), terminal.seq);
  }

  terminalEligibility(jobId: string): TerminalEligibility {
    const location = this.read(jobId);
    return terminalEligibility(this.runtime, location, (read) => {
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
    for (const name of this.runtime.storage.readdirSync(dir).sort()) {
      if (!name.endsWith('.json') || name <= afterId) continue;
      if (!budget.canContinue()) return cursor;
      const refusalPath = join(this.root, 'compaction-refusals.v1', name);
      try {
        const stored = optionalJson(this.runtime, join(dir, name), locationSchema);
        const location = stored === null ? null : viewLocation(stored);
        if (location?.detail.kind === 'unreadable') throw new Error('location-detail-unreadable');
        if (
          location !== null &&
          hasReadableTerminalDetail(location) &&
          location.detail.kind === 'recorded' &&
          location.detail.value.events.length > 1
        ) {
          mutate(() =>
            this.withRevisionLock(location.epochKey, () => {
              const current = optionalJson(this.runtime, join(dir, name), locationSchema);
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
              if (!isDeepStrictEqual(current.detail, detail))
                atomicJson(this.runtime, join(dir, name), { ...current, detail });
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
