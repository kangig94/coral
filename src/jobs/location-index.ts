import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { acquireDirectoryLockSync } from '../infra/fs-lock.js';
import type { ResolvableCoralEventInput } from '../store/envelope.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import type { JobDetailResponse, JobKind } from './records.js';

const subjectSchema = z.object({
  projectRoot: z.string().min(1),
  workDir: z.string().nullable(),
  jobKind: z.enum(['provider', 'workflow', 'kb']),
});
const controllerSchema = z.object({
  buildSetId: z.string().min(1),
  instanceId: z.string().min(1),
  controlGeneration: z.number().int().nonnegative(),
});
const locationSchema = z.object({
  version: z.literal('v1'),
  jobId: z.string().min(1),
  epochKey: z.string().min(1),
  subject: subjectSchema,
  controller: controllerSchema.optional(),
  disposition: z.enum(['active-owner', 'unresolved', 'terminal']),
  terminalSeq: z.number().int().nonnegative().optional(),
  resultPath: z.string().optional(),
  detail: z.unknown().optional(),
}).passthrough();
const revisionSchema = z.object({ version: z.literal('v1'), revision: z.number().int().nonnegative() }).passthrough();
const certificateSchema = z.object({
  version: z.literal('v1'),
  epochKey: z.string().min(1),
  revision: z.number().int().nonnegative(),
  jobIds: z.array(z.string().min(1)),
  terminalHighWaterSeq: z.number().int().nonnegative(),
}).passthrough();
const unknownHoldSchema = z.object({ version: z.literal('v1'), reason: z.string().min(1) }).passthrough();

export type JobLocation = Omit<z.infer<typeof locationSchema>, 'detail'> & { detail?: JobDetailResponse };
export type JobLocationSubject = Readonly<{ projectRoot: string; workDir: string | null; jobKind: JobKind }>;
export type JobLocationController = z.infer<typeof controllerSchema>;
export type JobLocationCertificate = z.infer<typeof certificateSchema>;

function atomicJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = `${path}.stage.${process.pid}.${randomUUID()}`;
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, path);
  const parentFd = openSync(parent, 'r');
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

function optionalJson<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export class JobLocationIndex {
  private readonly root: string;

  constructor(stateRoot: string) {
    this.root = join(stateRoot, 'job-locations.v1');
  }

  private jobPath(jobId: string): string {
    return join(this.root, 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
  }

  private epochPath(epochKey: string, name: string): string {
    return join(this.root, 'epochs', Buffer.from(epochKey).toString('base64url'), name);
  }

  private withRevisionLock<T>(epochKey: string, action: () => T): T {
    const lockDir = this.epochPath(epochKey, 'revision.lock');
    mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
    const release = acquireDirectoryLockSync(lockDir);
    try {
      return action();
    } finally {
      release();
    }
  }

  private advanceRevision(epochKey: string): number {
    const revisionPath = this.epochPath(epochKey, 'revision.v1.json');
    const previous = optionalJson(revisionPath, revisionSchema)?.revision ?? 0;
    const revision = previous + 1;
    atomicJson(revisionPath, { version: 'v1', revision });
    return revision;
  }

  read(jobId: string): JobLocation | null {
    const record = optionalJson(this.jobPath(jobId), locationSchema);
    return record === null ? null : (record as JobLocation);
  }

  register(jobId: string, epochKey: string, subject: JobLocationSubject,
    controller?: JobLocationController): JobLocation {
    return this.withRevisionLock(epochKey, () => {
      const existing = this.read(jobId);
      if (existing !== null) {
        if (existing.epochKey !== epochKey) throw new Error(`Job ${jobId} already belongs to another epoch`);
        return existing;
      }
      this.advanceRevision(epochKey);
      const location: JobLocation = {
        version: 'v1', jobId, epochKey, subject,
        ...(controller === undefined ? {} : { controller }),
        disposition: 'active-owner',
      };
      atomicJson(this.jobPath(jobId), location);
      return location;
    });
  }

  beforeAppend(input: ResolvableCoralEventInput<unknown, unknown>, epochKey: string,
    controller?: JobLocationController): void {
    if (input.stream.kind !== 'job') return;
    if (input.type === 'job.launch.requested') {
      const launch = jobLaunchRequestBodySchema.parse(input.body);
      this.register(input.stream.id, epochKey, {
        projectRoot: launch.projectRoot,
        workDir: launch.jobKind === 'kb' ? null : launch.request.cwd,
        jobKind: launch.jobKind,
      }, controller);
    } else if (input.type === 'job.terminal.recorded') {
      this.invalidateTerminalCertificate(epochKey);
    }
  }

  invalidateTerminalCertificate(epochKey: string): void {
    this.withRevisionLock(epochKey, () => { this.advanceRevision(epochKey); });
  }

  recordTerminal(jobId: string, detail: JobDetailResponse, resultPath: string, terminalSeq: number): JobLocation {
    const existing = this.read(jobId);
    if (existing === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
    return this.withRevisionLock(existing.epochKey, () => {
      const current = this.read(jobId);
      if (current === null) throw new Error(`Terminal has no durable job location: ${jobId}`);
      const location: JobLocation = {
        ...current,
        subject: {
          projectRoot: detail.status.projectRoot,
          workDir: detail.status.workDir,
          jobKind: detail.status.jobKind,
        },
        disposition: 'terminal',
        terminalSeq,
        resultPath,
        detail,
      };
      atomicJson(this.jobPath(jobId), location);
      return location;
    });
  }

  recordObserved(jobId: string, detail: JobDetailResponse): void {
    const existing = this.read(jobId);
    if (existing === null || existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.read(jobId);
      if (current === null || current.disposition === 'terminal') return;
      atomicJson(this.jobPath(jobId), { ...current, detail });
    });
  }

  markUnresolved(jobId: string): void {
    const existing = this.read(jobId);
    if (existing === null) throw new Error(`Unresolved job has no durable location: ${jobId}`);
    if (existing.disposition === 'terminal') return;
    this.withRevisionLock(existing.epochKey, () => {
      this.advanceRevision(existing.epochKey);
      atomicJson(this.jobPath(jobId), { ...existing, disposition: 'unresolved' });
    });
  }

  markUncertified(jobId: string): void {
    const existing = this.read(jobId);
    if (existing === null) throw new Error(`Uncertified job has no durable location: ${jobId}`);
    this.withRevisionLock(existing.epochKey, () => {
      const current = this.read(jobId);
      if (current === null) throw new Error(`Uncertified job has no durable location: ${jobId}`);
      this.advanceRevision(current.epochKey);
      const { terminalSeq: _terminalSeq, resultPath: _resultPath, detail: _detail, ...identity } = current;
      atomicJson(this.jobPath(jobId), { ...identity, disposition: 'unresolved' });
    });
  }

  holdUnknownLocations(epochKey: string, reason: string): void {
    this.withRevisionLock(epochKey, () => {
      this.advanceRevision(epochKey);
      atomicJson(this.epochPath(epochKey, 'unknown-locations.v1.json'), { version: 'v1', reason });
    });
  }

  clearUnknownLocations(epochKey: string): void {
    this.withRevisionLock(epochKey, () => {
      const path = this.epochPath(epochKey, 'unknown-locations.v1.json');
      if (!existsSync(path)) return;
      unlinkSync(path);
      this.advanceRevision(epochKey);
      const fd = openSync(dirname(path), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }

  unknownLocationHold(epochKey: string): string | null {
    return optionalJson(this.epochPath(epochKey, 'unknown-locations.v1.json'), unknownHoldSchema)?.reason ?? null;
  }

  locationsFor(epochKey: string): JobLocation[] {
    const dir = join(this.root, 'jobs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => optionalJson(join(dir, name), locationSchema))
      .filter((value): value is z.infer<typeof locationSchema> => value !== null && value.epochKey === epochKey)
      .map((value) => value as JobLocation);
  }

  certify(epochKey: string, terminalHighWaterSeq: number): JobLocationCertificate | null {
    return this.withRevisionLock(epochKey, () => {
      const locations = this.locationsFor(epochKey);
      if (this.unknownLocationHold(epochKey) !== null) return null;
      if (locations.some((location) => location.disposition !== 'terminal')) return null;
      const revision = optionalJson(this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
      const certificate = certificateSchema.parse({
        version: 'v1', epochKey, revision,
        jobIds: locations.map((location) => location.jobId).sort(),
        terminalHighWaterSeq,
      });
      atomicJson(this.epochPath(epochKey, 'certificate.v1.json'), certificate);
      return certificate;
    });
  }

  certificate(epochKey: string): JobLocationCertificate | null {
    const certificate = optionalJson(this.epochPath(epochKey, 'certificate.v1.json'), certificateSchema);
    const revision = optionalJson(this.epochPath(epochKey, 'revision.v1.json'), revisionSchema)?.revision ?? 0;
    return certificate?.revision === revision ? certificate : null;
  }

  resultsReleased(epochKey: string): boolean {
    const certificate = this.certificate(epochKey);
    if (certificate === null) return false;
    return certificate.jobIds.every((jobId) => {
      const location = this.read(jobId);
      if (location?.disposition !== 'terminal' || location.resultPath === undefined) return false;
      try {
        const fd = openSync(location.resultPath, 'r');
        try {
          const artifact = fstatSync(fd);
          return artifact.isFile() && artifact.size > 0;
        } finally {
          closeSync(fd);
        }
      } catch {
        return false;
      }
    });
  }
}
