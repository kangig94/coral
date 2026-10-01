import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { createSharedFileLockSync, attemptExclusiveFileLockSync, type FileLockLease } from './fs-lock.js';
import { observeProcessLiveness } from './node-process.js';
import { isNoEntryError } from './fs-errors.js';
import { probeProcessIncarnation, processIncarnationSchema } from './node-process.js';

const processSchema = z.object({ pid: z.number().int().positive(), incarnation: processIncarnationSchema });
const admissionSchema = z
  .object({
    version: z.literal(1),
    launchId: z.string().uuid(),
    child: processSchema,
    parent: processSchema,
    admittedAt: z.number().int().positive(),
    admittedMonotonicMs: z.number().int().nonnegative().optional(),
    lifetime: z.object({ dev: z.number(), ino: z.number() }).optional(),
    discoveredAt: z.number().int().positive().optional(),
    build: z.object({
      version: z.string().min(1),
      buildSetId: z.string().min(1),
      bundleHash: z.string().min(1),
      flavor: z.enum(['prod', 'dev']),
    }),
    purpose: z.enum(['startup', 'contender', 'succession', 'recovery', 'legacy-retirement']),
  })
  .passthrough();

export type LaunchAdmission = z.infer<typeof admissionSchema>;
export type LaunchAdmissionRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'readable'; admission: LaunchAdmission }>
  | Readonly<{ kind: 'unreadable'; path: string }>;

export function launchAdmissionPath(runDir: string, launchId: string): string {
  return join(runDir, 'launch-admissions.v2', `${z.string().uuid().parse(launchId)}.json`);
}

/** Called by the admitted child before it can enter coordinator startup. */
export function publishLaunchAdmission(runDir: string, admission: LaunchAdmission): void {
  acquireLaunchLifetime(runDir, admission);
  const path = launchAdmissionPath(runDir, admission.launchId);
  const dir = join(runDir, 'launch-admissions.v2');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    const lifetime = lifetimes.get(path);
    if (lifetime === undefined) throw new Error('Coordinator lifetime was not acquired');
    const current = lstatSync(lifetime.path);
    if (current.dev !== lifetime.inode.dev || current.ino !== lifetime.inode.ino)
      throw new Error('Coordinator lifetime inode changed');
    writeFileSync(temporary, JSON.stringify(admissionSchema.parse({ ...admission, lifetime: lifetime.inode })), {
      mode: 0o600,
      flag: 'wx',
    });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error: unknown) {
    try {
      unlinkSync(temporary);
    } catch {
      /* The temporary file may not exist. */
    }
    throw error;
  }
}

export function readLaunchAdmission(runDir: string, launchId: string): LaunchAdmissionRead {
  let path: string;
  try {
    path = launchAdmissionPath(runDir, launchId);
  } catch {
    return { kind: 'unreadable', path: join(runDir, 'launch-admissions.v2') };
  }
  try {
    const admission = admissionSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return admission.launchId === launchId ? { kind: 'readable', admission } : { kind: 'unreadable', path };
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'unreadable', path };
  }
}

export function listLaunchAdmissions(runDir: string): readonly LaunchAdmissionRead[] {
  let names: string[];
  try {
    names = readdirSync(join(runDir, 'launch-admissions.v2'));
  } catch (error: unknown) {
    return isNoEntryError(error) ? [] : [{ kind: 'unreadable', path: join(runDir, 'launch-admissions.v2') }];
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => readLaunchAdmission(runDir, name.slice(0, -5)));
}

/** Only the child that published this identity may remove it. */
export function removeOwnLaunchAdmission(runDir: string, launchId: string): void {
  const observed = readLaunchAdmission(runDir, launchId);
  if (
    observed.kind !== 'readable' ||
    observed.admission.child.pid !== process.pid ||
    observed.admission.child.incarnation !== probeProcessIncarnation(process.pid)
  )
    return;
  try {
    unlinkSync(launchAdmissionPath(runDir, launchId));
  } catch (error: unknown) {
    if (!isNoEntryError(error)) process.stderr.write(`Coordinator admission cleanup failed: ${String(error)}\n`);
  }
}

const lifetimes = new Map<string, { path: string; lease: FileLockLease; inode: { dev: number; ino: number } }>();

function admissionEnvelope(admission: LaunchAdmission): LaunchAdmission {
  const { version, launchId, child, parent, admittedAt, admittedMonotonicMs, build, purpose } = admission;
  return { version, launchId, child, parent, admittedAt, admittedMonotonicMs, build, purpose };
}

/** The address is immutable; no timestamp from the filesystem can establish admission timing. */
function launchLifetimePath(runDir: string, admission: LaunchAdmission): string {
  const envelope = admissionEnvelope(admissionSchema.parse(admission));
  const encoded = deflateRawSync(
    Buffer.from(
      JSON.stringify([
        envelope.child.pid,
        envelope.child.incarnation,
        envelope.parent.pid,
        envelope.parent.incarnation,
        envelope.admittedAt,
        envelope.purpose,
        envelope.build.version,
        envelope.build.buildSetId,
        envelope.build.bundleHash,
        envelope.build.flavor,
        ...(envelope.admittedMonotonicMs === undefined ? [] : [envelope.admittedMonotonicMs]),
      ]),
    ),
  ).toString('base64url');
  return join(runDir, 'launch-lifetimes.v1', envelope.launchId, ...(encoded.match(/.{1,180}/g) ?? []), 'lifetime.lock');
}

/** SQLite descriptors are process-local and close on exec; the kernel releases this lease at exit. */
function acquireLaunchLifetime(runDir: string, admission: LaunchAdmission): void {
  const path = launchLifetimePath(runDir, admission);
  const key = launchAdmissionPath(runDir, admission.launchId);
  const existing = lifetimes.get(key);
  if (existing !== undefined && existing.path !== path) throw new Error('Coordinator admission envelope is immutable');
  if (existing === undefined) {
    const root = join(runDir, 'launch-lifetimes.v1');
    const published = join(root, admission.launchId);
    if (!existsSync(dirname(path))) {
      const temporary = launchPreparationPath(runDir, admission);
      const temporaryPath = join(temporary, relative(published, path));
      try {
        mkdirSync(dirname(temporaryPath), { recursive: true, mode: 0o700 });
        if (existsSync(published)) {
          if (readdirSync(published).length !== 0)
            throw new Error('Coordinator admission envelope is incomplete or conflicting');
          const [firstChunk] = readdirSync(temporary);
          renameSync(join(temporary, firstChunk), join(published, firstChunk));
        } else renameSync(temporary, published);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    const lease = createSharedFileLockSync(path);
    const { dev, ino } = lstatSync(path);
    lifetimes.set(key, { path, lease, inode: { dev, ino } });
  }
}

const preparationName = /^\.([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9a-f]{64})\.tmp$/iu;

function launchPreparationPath(runDir: string, admission: LaunchAdmission): string {
  const identity = createHash('sha256').update(admission.child.incarnation).digest('hex');
  return join(runDir, 'launch-lifetimes.v1', `.${admission.launchId}.${admission.child.pid}.${identity}.tmp`);
}

/** An unpublished hierarchy may be pruned only after the exact publisher is proven absent. */
export function removeAbandonedLaunchPreparations(runDir: string): string[] {
  const root = join(runDir, 'launch-lifetimes.v1');
  const failures: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const match = preparationName.exec(name);
      if (match === null) continue;
      const pid = Number(match[2]);
      const observed = probeProcessIncarnation(pid);
      if (
        observeProcessLiveness(pid) !== 'absent' &&
        (observed === null || createHash('sha256').update(observed).digest('hex') === match[3])
      )
        continue;
      const path = join(root, name);
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        failures.push(path);
      }
    }
  } catch (error: unknown) {
    if (!isNoEntryError(error)) failures.push(root);
  }
  return failures;
}

export type LaunchSubject = Readonly<{
  path: string;
  admission?: LaunchAdmission;
  conflictingAdmission?: LaunchAdmission;
  lifetimePath?: string;
  inode?: { dev: number; ino: number };
  acquisitionComplete: boolean;
  problem?: 'envelope-conflict' | 'envelope-unavailable';
}>;

function sameEnvelope(a: LaunchAdmission, b: LaunchAdmission): boolean {
  return JSON.stringify(admissionEnvelope(a)) === JSON.stringify(admissionEnvelope(b));
}

/** Neither damaged JSON nor an acquisition window may erase a possible live subject. */
export function listLaunchSubjects(runDir: string): LaunchSubject[] {
  const subjects: LaunchSubject[] = [];
  const root = join(runDir, 'launch-lifetimes.v1');
  const visit = (path: string, launchId: string, chunks: string[]): void => {
    try {
      const names = readdirSync(path);
      if (names.length > 1 || chunks.length > 20) {
        subjects.push({ path, acquisitionComplete: false, problem: 'envelope-conflict' });
        return;
      }
      const name = names[0] ?? 'lifetime.lock';
      if (name !== 'lifetime.lock') {
        visit(join(path, name), launchId, [...chunks, name]);
        return;
      }
      const lifetimePath = join(path, name);
      const tuple: unknown = JSON.parse(
        inflateRawSync(Buffer.from(chunks.join(''), 'base64url'), { maxOutputLength: 8192 }).toString('utf8'),
      );
      if (!Array.isArray(tuple) || (tuple.length !== 10 && tuple.length !== 11))
        throw new Error('Incomplete lifetime envelope');
      const envelope = admissionSchema.parse({
        version: 1,
        launchId,
        child: { pid: tuple[0], incarnation: tuple[1] },
        parent: { pid: tuple[2], incarnation: tuple[3] },
        admittedAt: tuple[4],
        admittedMonotonicMs: tuple[10],
        purpose: tuple[5],
        build: { version: tuple[6], buildSetId: tuple[7], bundleHash: tuple[8], flavor: tuple[9] },
      });
      if (envelope.launchId !== launchId || launchLifetimePath(runDir, envelope) !== lifetimePath)
        throw new Error('Lifetime launch identity mismatch');
      let inode: { dev: number; ino: number } | undefined;
      try {
        const { dev, ino } = lstatSync(lifetimePath);
        inode = { dev, ino };
      } catch (error: unknown) {
        if (!isNoEntryError(error)) throw error;
      }
      const json = readLaunchAdmission(runDir, launchId);
      const conflict = json.kind === 'readable' && !sameEnvelope(envelope, json.admission);
      subjects.push({
        path: launchAdmissionPath(runDir, launchId),
        lifetimePath,
        inode,
        admission: json.kind === 'readable' && !conflict ? json.admission : envelope,
        ...(conflict && json.kind === 'readable'
          ? { problem: 'envelope-conflict' as const, conflictingAdmission: json.admission }
          : {}),
        acquisitionComplete:
          json.kind === 'readable' &&
          !conflict &&
          inode !== undefined &&
          json.admission.lifetime?.dev === inode.dev &&
          json.admission.lifetime.ino === inode.ino,
      });
    } catch {
      subjects.push({ path, acquisitionComplete: false, problem: 'envelope-unavailable' });
    }
  };
  try {
    for (const id of readdirSync(root)) {
      if (preparationName.test(id)) continue;
      visit(join(root, id), id, []);
    }
  } catch (error: unknown) {
    if (!isNoEntryError(error))
      subjects.push({ path: root, acquisitionComplete: false, problem: 'envelope-unavailable' });
  }
  for (const json of listLaunchAdmissions(runDir)) {
    if (json.kind === 'absent') continue;
    const path = json.kind === 'readable' ? launchAdmissionPath(runDir, json.admission.launchId) : json.path;
    if (subjects.some((subject) => subject.path === path)) continue;
    subjects.push({
      path,
      ...(json.kind === 'readable' ? { admission: json.admission } : {}),
      acquisitionComplete: false,
      problem: 'envelope-unavailable',
    });
  }
  return subjects;
}

type LaunchSubjectDisposition = 'occupied' | 'acquisition-window' | 'unknown' | 'absent';

/** An exclusive probe before the first shared acquisition is not evidence of lease release. */
export function observeLaunchSubject(subject: LaunchSubject): LaunchSubjectDisposition {
  if (subject.admission === undefined) return 'unknown';
  const { child } = subject.admission;
  const incarnation = probeProcessIncarnation(child.pid);
  const absent =
    (incarnation !== null && incarnation !== child.incarnation) || observeProcessLiveness(child.pid) === 'absent';
  const conflict = subject.conflictingAdmission?.child;
  const conflictIncarnation = conflict === undefined ? null : probeProcessIncarnation(conflict.pid);
  if (
    absent &&
    (conflict === undefined ||
      observeProcessLiveness(conflict.pid) === 'absent' ||
      (conflictIncarnation !== null && conflictIncarnation !== conflict.incarnation))
  )
    return 'absent';
  if (subject.problem !== undefined) return 'unknown';
  if (subject.lifetimePath === undefined) return 'unknown';
  const attempt = attemptExclusiveFileLockSync(subject.lifetimePath);
  if (attempt.kind !== 'acquired') return attempt.kind === 'contended' ? 'occupied' : 'unknown';
  let sameInode = false;
  try {
    const current = lstatSync(subject.lifetimePath);
    sameInode = subject.inode?.dev === current.dev && subject.inode.ino === current.ino;
  } catch {
    /* A missing or unreadable inode cannot prove release. */
  } finally {
    attempt.lease();
  }
  if (!sameInode) return 'unknown';
  if (subject.acquisitionComplete) return 'absent';
  return incarnation === child.incarnation ? 'occupied' : 'acquisition-window';
}

/** Only the namespace lock holder calls this after independently settling the exact subject. */
export function removeAbsentLaunchSubject(subject: LaunchSubject): boolean {
  if (subject.admission === undefined || subject.lifetimePath === undefined) return false;
  if (observeLaunchSubject(subject) !== 'absent') return false;
  const runDir = dirname(dirname(subject.path));
  const published = join(runDir, 'launch-lifetimes.v1', subject.admission.launchId);
  const temporary = launchPreparationPath(runDir, subject.admission);
  try {
    if (existsSync(published)) {
      const current = listLaunchSubjects(runDir).find((entry) => entry.lifetimePath === subject.lifetimePath);
      if (
        current?.admission === undefined ||
        !sameEnvelope(current.admission, subject.admission) ||
        observeLaunchSubject(current) !== 'absent'
      )
        return false;
    }
    let inode: ReturnType<typeof lstatSync> | undefined;
    try {
      inode = lstatSync(subject.lifetimePath);
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
    let release: FileLockLease | undefined;
    if (inode !== undefined) {
      if (subject.inode !== undefined && (inode.dev !== subject.inode.dev || inode.ino !== subject.inode.ino))
        return false;
      const attempt = attemptExclusiveFileLockSync(subject.lifetimePath);
      if (attempt.kind !== 'acquired') return false;
      release = attempt.lease;
    }
    try {
      if (inode !== undefined) {
        const current = lstatSync(subject.lifetimePath);
        if (current.dev !== inode.dev || current.ino !== inode.ino) return false;
      }
      let jsonInode: ReturnType<typeof lstatSync> | undefined;
      try {
        jsonInode = lstatSync(subject.path);
      } catch (error: unknown) {
        if (!isNoEntryError(error)) throw error;
      }
      if (jsonInode !== undefined) {
        const json = readLaunchAdmission(dirname(dirname(subject.path)), subject.admission.launchId);
        if (
          json.kind === 'readable' &&
          !sameEnvelope(json.admission, subject.admission) &&
          (subject.conflictingAdmission === undefined || !sameEnvelope(json.admission, subject.conflictingAdmission))
        )
          return false;
        const checked = lstatSync(subject.path);
        if (checked.dev !== jsonInode.dev || checked.ino !== jsonInode.ino) return false;
        unlinkSync(subject.path);
      }
      try {
        renameSync(published, temporary);
      } catch (error: unknown) {
        if (!isNoEntryError(error)) throw error;
      }
    } finally {
      release?.();
    }
    rmSync(temporary, { recursive: true, force: true });
    return true;
  } catch (error: unknown) {
    process.stderr.write(`Coordinator admission cleanup failed: ${String(error)}\n`);
    return false;
  }
}
