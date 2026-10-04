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
import { jobDiagnosticsSchema, jobTerminalSchema, jobTerminalRecordedBodySchema } from './terminal/result.js';
import { observeResolvedStoreEpoch } from '../store/epoch/observation.js';
import { observeStorePath } from '../store/path-observation.js';
import { protectedStoreEpochRoot } from '../store/epoch/protection.js';
import { TerminalResultExportOwner, resultPathFor, type WorkflowReportPort } from './terminal/export.js';
import { sameTerminal, validatedTerminal } from './terminal/identity.js';
import { readAcceptedTerminal, withTerminalSource } from './terminal/source.js';
import { readIntactJobTerminalAge, readJobTerminalAge } from './terminal-age.js';
import { trustedJobRetentionCutoff } from './retention-clock.js';
import { composeReducers } from '../store/reducers.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { jobsRegistry } from './events.js';
import type { Database } from '../store/db.js';
import { terminalEligibility, type TerminalEligibility } from './export-retention.js';
import { type HistoricalSourceRead, readHistoricalSource, type HistoricalSourceReader } from './historical-reader.js';
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
const locationSchema = locationIdentitySchema
  .extend({ detail: z.unknown().optional(), terminalAge: z.unknown().optional() })
  .passthrough();
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

export type JobLocation = z.infer<typeof locationIdentitySchema> & { detail: JobLocationDetail; terminalAge?: unknown };

export type UnknownLocationHold = Readonly<{ epochKey: string; reason: string; retryScheduled: boolean }>;

export interface JobLocationView {
  readHistorical?: HistoricalSourceReader;
  readonly time: TimePort;
  read(jobId: string): JobLocation | null;
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
    return next.map((item, index) => {
      const event = typeof item === 'object' && item !== null && 'seq' in item && 'type' in item;
      const matching = event
        ? previous.find(
            (candidate) =>
              typeof candidate === 'object' &&
              candidate !== null &&
              candidate.seq === item.seq &&
              candidate.type === item.type,
          )
        : previous[index];
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

export function hasReadableTerminalDetail(location: JobLocation): boolean {
  if (
    location.disposition !== 'terminal' ||
    location.terminalSeq === undefined ||
    location.detail.kind !== 'recorded'
  ) {
    return false;
  }
  const detail = location.detail.value;
  return (
    detail.status.projectRoot === location.subject.projectRoot &&
    detail.status.workDir === location.subject.workDir &&
    detail.status.jobKind === location.subject.jobKind &&
    validatedTerminal(detail, location.jobId, location.epochKey, location.terminalSeq) !== null
  );
}
export type JobLocationSubject = Readonly<{ projectRoot: string; workDir: string | null; jobKind: JobKind }>;
export type JobLocationController = z.infer<typeof controllerSchema>;
export type JobLocationCertificate = z.infer<typeof certificateSchema>;

function atomicJson(runtime: Runtime, path: string, value: unknown): void {
  const parent = dirname(path);
  runtime.storage.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })) {
    throw new Error(`Could not write job location record: ${path}`);
  }
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
  readonly resultRepairFailures = new Set<string>();
  readonly time: TimePort;
  private readonly root: string;
  private locationsStamp: string | undefined;
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

  private epochPath(epochKey: string, name: string): string {
    return join(this.root, 'epochs', this.runtime.ids.sha256(epochKey), name);
  }

  private withRevisionLock<T>(epochKey: string, action: () => T): T {
    const lockDir = this.epochPath(epochKey, 'revision.lock');
    this.runtime.storage.mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
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
    atomicJson(this.runtime, revisionPath, { ...previous, version: 'v1', revision });
    return revision;
  }

  private readStored(jobId: string): StoredJobLocation | null {
    return optionalJson(this.runtime, this.jobPath(jobId), locationSchema);
  }

  read(jobId: string): JobLocation | null {
    const stored = this.readStored(jobId);
    return stored === null ? null : viewLocation(stored);
  }

  readHistorical(epochKey: string, jobIds: readonly string[]): HistoricalSourceRead {
    return readHistoricalSource(this, epochKey, jobIds);
  }

  readOnlyView(): JobLocationView {
    return {
      time: this.time,
      read: (jobId) => this.read(jobId),
      resultPathFor: (jobId) => this.resultPathFor(jobId),
      unknownLocationHolds: () => this.unknownLocationHolds(),
      readHistorical: (epochKey, jobIds) => this.readHistorical(epochKey, jobIds),
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
        if (existing.epochKey !== epochKey) throw new Error(`Job ${jobId} already belongs to another epoch`);
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

  /** Only synchronous post-commit observers may assert newlyAppended; later hydration verifies the retained source. */
  recordTerminal(
    jobId: string,
    detail: JobDetailResponse,
    resultPath: string,
    terminalSeq: number,
    sourceDb?: Database,
    newlyAppended = false,
  ): JobLocation {
    const existing = this.readStored(jobId);
    if (existing === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
    const terminal = validatedTerminal(detail, jobId, existing.epochKey, terminalSeq);
    if (terminal === null) throw new Error(`Terminal detail disagrees: ${jobId}`);
    const capture = (db: Database): unknown => {
      const accepted = readAcceptedTerminal(db, jobId);
      if (!accepted || accepted.seq !== terminalSeq || accepted.ts !== terminal.ts)
        throw new Error(`Source terminal identity disagrees: ${jobId}`);
      const sourceTerminal = jobTerminalRecordedBodySchema.parse(
        JSON.parse(Buffer.from(accepted.body).toString('utf8')),
      ).terminal;
      if (!sameTerminal(sourceTerminal, terminal.result))
        throw new Error(`Source terminal content disagrees: ${jobId}`);
      const age = newlyAppended
        ? readJobTerminalAge(db, accepted)
        : readIntactJobTerminalAge(db, accepted, trustedJobRetentionCutoff(this.runtime));
      return {
        epochKey: existing.epochKey,
        terminalSeq,
        terminalTimestamp: accepted.ts,
        ...(typeof age === 'number' ? { kind: 'known', terminalAt: age } : { kind: age }),
      };
    };
    let terminalAge = existing.terminalAge;
    const captured = sourceDb && existing.terminalAge === undefined ? capture(sourceDb) : undefined;
    if (existing.terminalAge === undefined) {
      if (sourceDb) terminalAge = captured;
      else {
        try {
          terminalAge = withTerminalSource(this.runtime, existing.epochKey, capture) ?? terminalAge;
        } catch {
          terminalAge = undefined;
        }
      }
    }
    return this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
      if (current === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
      const retainedAge = current.terminalAge ?? terminalAge;
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
        ...(retainedAge === undefined ? {} : { terminalAge: retainedAge }),
        detail: preserveStoredDetail(current.detail, { ...detail, epochKey: current.epochKey, events: [terminal] }),
      };
      if (!isDeepStrictEqual(current, location)) {
        atomicJson(this.runtime, this.jobPath(jobId), location);
        this.locationsStamp = undefined;
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
      const location = {
        ...current,
        detail: preserveStoredDetail(current.detail, detail),
      };
      if (!isDeepStrictEqual(current, location)) {
        atomicJson(this.runtime, this.jobPath(jobId), location);
        this.locationsStamp = undefined;
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
      if (current === null || current.epochKey !== epochKey || current.disposition === 'terminal') return;
      this.runtime.storage.unlinkSync(this.jobPath(jobId));
      this.advanceRevision(epochKey);
      if (!this.runtime.storage.syncDirectoryDurableSync(dirname(this.jobPath(jobId)))) {
        throw new Error(`Could not sync job location directory: ${dirname(this.jobPath(jobId))}`);
      }
    });
  }

  holdUnknownLocations(epochKey: string, reason: string, retryScheduled = false): void {
    this.withRevisionLock(epochKey, () => {
      this.advanceRevision(epochKey);
      const path = this.epochPath(epochKey, 'unknown-locations.v1.json');
      const previous = optionalJson(this.runtime, path, unknownHoldSchema);
      atomicJson(this.runtime, path, { ...previous, version: 'v1', epochKey, reason, retryScheduled });
    });
  }

  clearUnknownLocations(epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      const path = this.epochPath(epochKey, 'unknown-locations.v1.json');
      if (!this.runtime.storage.existsSync(path)) return;
      this.runtime.storage.unlinkSync(path);
      this.advanceRevision(epochKey);
      if (!this.runtime.storage.syncDirectoryDurableSync(dirname(path))) {
        throw new Error(`Could not sync job location directory: ${dirname(path)}`);
      }
    });
  }

  unknownLocationHold(epochKey: string): string | null {
    return (
      optionalJson(this.runtime, this.epochPath(epochKey, 'unknown-locations.v1.json'), unknownHoldSchema)?.reason ??
      null
    );
  }

  unknownLocationHolds(): UnknownLocationHold[] {
    const root = join(this.root, 'epochs');
    if (!this.runtime.storage.existsSync(root)) return [];
    return this.runtime.storage.readdirSync(root).flatMap((key) => {
      const hold = optionalJson(this.runtime, join(root, key, 'unknown-locations.v1.json'), unknownHoldSchema);
      return hold === null
        ? []
        : [{ epochKey: hold.epochKey ?? key, reason: hold.reason, retryScheduled: hold.retryScheduled === true }];
    });
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

  locationsFor(epochKey: string): JobLocation[] {
    const dir = join(this.root, 'jobs');
    const stat = this.runtime.storage.existsSync(dir) ? this.runtime.storage.lstatSync(dir, { bigint: true }) : null;
    const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}` : 'absent';
    if (this.locationsStamp !== stamp) {
      this.locationsByEpoch.clear();
      for (const location of this.locations()) {
        const locations = this.locationsByEpoch.get(location.epochKey) ?? [];
        locations.push(location);
        this.locationsByEpoch.set(location.epochKey, locations);
      }
      this.locationsStamp = stamp;
    }
    return [...(this.locationsByEpoch.get(epochKey) ?? [])];
  }

  certify(epochKey: string, terminalHighWaterSeq: number): JobLocationCertificate | null {
    return this.withRevisionLock(epochKey, () => {
      const scan = this.scan();
      const locations = scan.readable.filter((location) => location.epochKey === epochKey);
      if (this.unknownLocationHold(epochKey) !== null) return null;
      if (scan.unreadable.some((entry) => entry.epochKey === null || entry.epochKey === epochKey)) return null;
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
    const certificate = optionalJson(this.runtime, this.epochPath(epochKey, 'certificate.v1.json'), certificateSchema);
    const revision =
      optionalJson(this.runtime, this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
    return certificate?.revision === revision ? certificate : null;
  }

  resultsReleased(epochKey: string): boolean {
    const certificate = this.certificate(epochKey);
    if (certificate === null) return false;
    return certificate.jobIds.every((jobId) => this.resultDurable(jobId));
  }

  /** Proves the retained artifact for one job independently of other jobs in its epoch. */
  resultDurable(jobId: string): boolean {
    const location = this.read(jobId);
    if (location === null || !hasReadableTerminalDetail(location)) {
      return false;
    }
    const eligibility = this.terminalEligibility(jobId);
    if (eligibility.kind === 'expired') return true;
    if (
      eligibility.age === 'unknown' &&
      eligibility.ageUnproven &&
      eligibility.sourceReadable &&
      !eligibility.sourceReadFailed
    ) {
      try {
        if (
          observeStorePath(this.runtime.storage, dirname(location.resultPath ?? this.resultPathFor(jobId))) === 'absent'
        )
          return true;
      } catch {
        return false;
      }
    }
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
      hydrationRetry: () => this.unknownLocationHolds().find((hold) => hold.epochKey === epochKey)?.retryScheduled,
      prepareTerminal: (jobId) => {
        const current = this.read(jobId);
        if (this.unknownLocationHold(epochKey) !== null || (current && hasReadableTerminalDetail(current))) return;
        const read = this.readHistorical(epochKey, [jobId]);
        const location = read.kind === 'read' ? read.locations.get(jobId) : null;
        if (location && hasReadableTerminalDetail(location) && location.detail.kind === 'recorded')
          this.recordTerminal(
            jobId,
            location.detail.value,
            location.resultPath ?? resultPathFor(jobsRoot, jobId),
            location.terminalSeq ?? 0,
            db,
          );
      },
      location: (jobId) => this.read(jobId),
      withSource: (jobId, read) => (this.read(jobId)?.epochKey === epochKey ? read(db, ctx) : null),
    });
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
      if (location.epochKey === activeEpochKey) return 'released';
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
