import { dirname, join } from 'node:path';
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
import { isTerminalPhase, jobPhaseSchema } from './phase.js';
import { jobKindSchema, type JobDetailResponse, type JobKind } from './records.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './terminal/result.js';
import { observeResolvedStoreEpoch } from '../store/epoch/observation.js';
import { observeStorePath } from '../store/path-observation.js';
import { protectedStoreEpochRoot } from '../store/epoch/protection.js';

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
    controlGeneration: z.number().int().nonnegative(),
  })
  .passthrough();
const locationIdentitySchema = z.object({
  version: z.literal('v1'),
  jobId: z.string().min(1),
  epochKey: z.string().min(1),
  subject: subjectSchema,
  controller: controllerSchema.optional(),
  disposition: z.enum(['active-owner', 'unresolved', 'terminal']),
  terminalSeq: z.number().int().nonnegative().optional(),
  resultPath: z.string().optional(),
});
const locationSchema = locationIdentitySchema.extend({ detail: z.unknown().optional() }).passthrough();
const jobEventBaseSchema = z.object({
  jobId: z.string(),
  sessionId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
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
          workflowSlotGeneration: z.number().int().nonnegative().optional(),
          replacesWorkflowJobId: z.string().optional(),
          phase: jobPhaseSchema,
          updatedAt: z.string(),
          lastSeq: z.number().int().nonnegative().optional(),
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
const revisionSchema = z.object({ version: z.literal('v1'), revision: z.number().int().nonnegative() }).passthrough();
const certificateSchema = z
  .object({
    version: z.literal('v1'),
    epochKey: z.string().min(1),
    revision: z.number().int().nonnegative(),
    jobIds: z.array(z.string().min(1)),
    terminalHighWaterSeq: z.number().int().nonnegative(),
  })
  .passthrough();
const unknownHoldSchema = z.object({ version: z.literal('v1'), reason: z.string().min(1) }).passthrough();

type StoredJobLocation = z.infer<typeof locationSchema>;

export type JobLocationDetail =
  | Readonly<{ kind: 'recorded'; value: JobDetailResponse }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable' }>;

export type JobLocation = z.infer<typeof locationIdentitySchema> & { detail: JobLocationDetail };

function viewLocation(stored: StoredJobLocation): JobLocation {
  const { detail: raw, ...identity } = stored;
  if (raw === undefined) return { ...identity, detail: { kind: 'absent' } };
  const parsed = storedJobDetailSchema.safeParse(raw);
  return { ...identity, detail: parsed.success ? { kind: 'recorded', value: parsed.data } : { kind: 'unreadable' } };
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
  const { status, events, exit } = location.detail.value;
  return (
    status.jobId === location.jobId &&
    isTerminalPhase(status.phase) &&
    exit !== null &&
    events.some(
      (event) => event.type === 'terminal' && event.jobId === location.jobId && event.seq === location.terminalSeq,
    )
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
  readonly time: TimePort;
  private readonly root: string;
  private readonly runtime: Runtime;

  constructor(runtime: Runtime, stateRoot: string) {
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
    const revisionPath = this.epochPath(epochKey, 'revision.v1.json');
    const previous = optionalJson(this.runtime, revisionPath, revisionSchema);
    const revision = (previous?.revision ?? 0) + 1;
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

  recordTerminal(jobId: string, detail: JobDetailResponse, resultPath: string, terminalSeq: number): JobLocation {
    const existing = this.read(jobId);
    if (existing === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
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
        detail: preserveStoredDetail(current.detail, detail),
      };
      atomicJson(this.runtime, this.jobPath(jobId), location);
      return viewLocation(location);
    });
  }

  recordObserved(jobId: string, detail: JobDetailResponse): void {
    const existing = this.read(jobId);
    if (existing === null || existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
      if (current === null || current.disposition === 'terminal') return;
      atomicJson(this.runtime, this.jobPath(jobId), {
        ...current,
        detail: preserveStoredDetail(current.detail, detail),
      });
    });
  }

  markUnresolved(jobId: string): void {
    const existing = this.readStored(jobId);
    if (existing === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
    if (existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.readStored(jobId);
      if (current === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
      if (current.disposition === 'terminal') return;
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

  holdUnknownLocations(epochKey: string, reason: string): void {
    this.withRevisionLock(epochKey, () => {
      this.advanceRevision(epochKey);
      const path = this.epochPath(epochKey, 'unknown-locations.v1.json');
      const previous = optionalJson(this.runtime, path, unknownHoldSchema);
      atomicJson(this.runtime, path, { ...previous, version: 'v1', reason });
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

  locations(): JobLocation[] {
    return this.scan().readable;
  }

  locationsFor(epochKey: string): JobLocation[] {
    return this.locations().filter((location) => location.epochKey === epochKey);
  }

  /** An unreadable location that may belong to an epoch must keep that epoch from being certified. */
  private unreadableLocationsFor(epochKey: string): string[] {
    return this.scan()
      .unreadable.filter((entry) => entry.epochKey === null || entry.epochKey === epochKey)
      .map((entry) => entry.file);
  }

  certify(epochKey: string, terminalHighWaterSeq: number): JobLocationCertificate | null {
    return this.withRevisionLock(epochKey, () => {
      const locations = this.locationsFor(epochKey);
      if (this.unknownLocationHold(epochKey) !== null) return null;
      if (this.unreadableLocationsFor(epochKey).length > 0) return null;
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
    return certificate.jobIds.every((jobId) => {
      const location = this.read(jobId);
      if (location === null || !hasReadableTerminalDetail(location) || location.resultPath === undefined) {
        return false;
      }
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
}
