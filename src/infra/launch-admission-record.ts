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
import { basename, dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import {
  createSharedFileLockSync,
  attemptExclusiveFileLockSync,
  repairMalformedFileLockSync,
  type FileLockLease,
} from './fs-lock.js';
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
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      z.string().uuid().safeParse(name.slice(0, -5)).success
        ? readLaunchAdmission(runDir, name.slice(0, -5))
        : { kind: 'unreadable' as const, path: join(runDir, 'launch-admissions.v2', name) },
    );
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
        let publicationParent = root;
        if (existsSync(published)) {
          if (readdirSync(published).length !== 0)
            throw new Error('Coordinator admission envelope is incomplete or conflicting');
          const [firstChunk] = readdirSync(temporary);
          renameSync(join(temporary, firstChunk), join(published, firstChunk));
          publicationParent = published;
        } else renameSync(temporary, published);
        const directoryFd = openSync(publicationParent, 'r');
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
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

function launchPreparationPath(runDir: string, admission: Pick<LaunchAdmission, 'launchId' | 'child'>): string {
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

type LaunchSubjectEvidence = Readonly<{
  path: string;
  launchId?: string;
  admission?: LaunchAdmission;
  conflictingAdmission?: LaunchAdmission;
  lifetimePath?: string;
  inode?: { dev: number; ino: number };
  acquisitionComplete: boolean;
  problem?: 'envelope-conflict' | 'envelope-unavailable';
}>;

type LifetimeDirectorySubject = LaunchSubjectEvidence &
  Readonly<{
    runDir: string;
    lifetimeDirectory: string;
    branches: readonly LaunchSubject[];
  }>;

export type LaunchSubject =
  | LifetimeDirectorySubject
  | (LaunchSubjectEvidence &
      Readonly<{
        runDir?: undefined;
        branches?: undefined;
        lifetimeDirectory?: string;
      }>);

function sameEnvelope(a: LaunchAdmission, b: LaunchAdmission): boolean {
  return JSON.stringify(admissionEnvelope(a)) === JSON.stringify(admissionEnvelope(b));
}

function lifetimeDirectorySnapshot(path: string): { path: string; dev: number; ino: number }[] {
  const stat = lstatSync(path);
  const entries = [{ path, dev: stat.dev, ino: stat.ino }];
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (/^lifetime\.lock-(journal|wal|shm)$/u.test(name)) continue;
      entries.push(...lifetimeDirectorySnapshot(join(path, name)));
    }
  }
  return entries;
}

function lifetimeDirectoryReleased(path: string): boolean {
  const releases: FileLockLease[] = [];
  try {
    for (const entry of lifetimeDirectorySnapshot(path)) {
      if (basename(entry.path) !== 'lifetime.lock') continue;
      const lock = attemptExclusiveFileLockSync(entry.path);
      if (lock.kind !== 'acquired') return false;
      releases.push(lock.lease);
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

const pendingLifetimeCleanups = new Map<string, { path: string; dev: number; ino: number }>();

function removeAbsentLifetimeDirectory(subject: LifetimeDirectorySubject): boolean {
  const releases: FileLockLease[] = [];
  try {
    const published = subject.lifetimeDirectory;
    const pending = pendingLifetimeCleanups.get(published);
    if (pending === undefined && observeLaunchSubject(subject) !== 'absent') return false;
    const directory = pending?.path ?? published;
    if (!existsSync(directory) && pending !== undefined) {
      pendingLifetimeCleanups.delete(published);
      return true;
    }
    const snapshot = lifetimeDirectorySnapshot(directory);
    if (pending !== undefined && (snapshot[0].dev !== pending.dev || snapshot[0].ino !== pending.ino)) return false;
    for (const entry of snapshot) {
      if (basename(entry.path) !== 'lifetime.lock') continue;
      const lock = attemptExclusiveFileLockSync(entry.path);
      if (lock.kind !== 'acquired') return false;
      releases.push(lock.lease);
      const checked = lstatSync(entry.path);
      if (checked.dev !== entry.dev || checked.ino !== entry.ino) return false;
    }
    if (pending === undefined) {
      const current = listLaunchSubjects(subject.runDir).find((entry) => entry.lifetimeDirectory === directory);
      if (
        current === undefined
          ? snapshot.length !== 1
          : current.branches === undefined || JSON.stringify(current) !== JSON.stringify(subject)
      )
        return false;
    }
    if (JSON.stringify(lifetimeDirectorySnapshot(directory)) !== JSON.stringify(snapshot)) return false;
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) return false;
    const temporary =
      pending?.path ??
      launchPreparationPath(subject.runDir, {
        launchId: randomUUID(),
        child: { pid: process.pid, incarnation },
      });
    if (pending === undefined) {
      mkdirSync(dirname(temporary), { recursive: true, mode: 0o700 });
      renameSync(directory, temporary);
      pendingLifetimeCleanups.set(published, { path: temporary, dev: snapshot[0].dev, ino: snapshot[0].ino });
    }
    for (const branch of subject.branches) {
      if (branch.admission === undefined) continue;
      const json = readLaunchAdmission(subject.runDir, branch.admission.launchId);
      if (json.kind === 'readable' && sameEnvelope(json.admission, branch.admission)) unlinkSync(branch.path);
    }
    rmSync(temporary, { recursive: true, force: true });
    pendingLifetimeCleanups.delete(published);
    return true;
  } catch (error: unknown) {
    process.stderr.write(`Coordinator lifetime cleanup failed: ${String(error)}\n`);
    return false;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Neither damaged JSON nor an acquisition window may erase a possible live subject. */
export function listLaunchSubjects(runDir: string): LaunchSubject[] {
  const subjects: LaunchSubject[] = [];
  const admissions = listLaunchAdmissions(runDir);
  const root = join(runDir, 'launch-lifetimes.v1');
  const visit = (path: string, launchId: string, chunks: string[]): void => {
    let lifetimePath: string | undefined;
    let inode: { dev: number; ino: number } | undefined;
    try {
      if (!lstatSync(path).isDirectory()) throw new Error('Lifetime envelope is not a directory');
      const names = readdirSync(path);
      if (names.length > 1) {
        for (const name of names) {
          const child = join(path, name);
          if (lstatSync(child).isDirectory()) visit(child, launchId, [...chunks, name]);
        }
        if (!names.includes('lifetime.lock')) return;
      }
      const name = names.includes('lifetime.lock') ? 'lifetime.lock' : (names[0] ?? 'lifetime.lock');
      if (name !== 'lifetime.lock') {
        visit(join(path, name), launchId, [...chunks, name]);
        return;
      }
      lifetimePath = join(path, name);
      try {
        const { dev, ino } = lstatSync(lifetimePath);
        inode = { dev, ino };
      } catch (error: unknown) {
        if (!isNoEntryError(error)) throw error;
      }
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
      const recorded = readLaunchAdmission(runDir, launchId);
      const matching = admissions.filter(
        (entry) =>
          entry.kind === 'readable' &&
          inode !== undefined &&
          entry.admission.lifetime?.dev === inode.dev &&
          entry.admission.lifetime.ino === inode.ino,
      );
      const json = recorded.kind !== 'readable' && matching.length === 1 ? matching[0] : recorded;
      const matchingAdmission =
        json?.kind === 'readable' &&
        inode !== undefined &&
        json.admission.lifetime?.dev === inode.dev &&
        json.admission.lifetime.ino === inode.ino;
      const addressedId = matchingAdmission && json?.kind === 'readable' ? json.admission.launchId : launchId;
      const addressed =
        z.string().uuid().safeParse(addressedId).success &&
        (json?.kind === 'unreadable' || matchingAdmission) &&
        lifetimePath !== undefined &&
        inode !== undefined;
      subjects.push({
        path: addressed ? launchAdmissionPath(runDir, addressedId) : path,
        ...(addressed
          ? { launchId: addressedId, lifetimePath, inode, lifetimeDirectory: join(root, launchId) }
          : inode === undefined
            ? {}
            : { lifetimePath, inode }),
        ...(matchingAdmission && json?.kind === 'readable' ? { admission: json.admission } : {}),
        acquisitionComplete: matchingAdmission,
        problem: 'envelope-unavailable',
      });
    }
  };
  try {
    for (const id of readdirSync(root)) {
      if (preparationName.test(id)) continue;
      const directory = join(root, id);
      const first = subjects.length;
      visit(directory, id, []);
      const branches = subjects.slice(first);
      if (branches.length !== 1 || (branches[0]?.admission === undefined && branches[0]?.launchId === undefined)) {
        const recorded = readLaunchAdmission(runDir, id);
        if (recorded.kind === 'readable' && !branches.some((branch) => branch.admission?.launchId === id)) {
          branches.push({
            path: launchAdmissionPath(runDir, id),
            admission: recorded.admission,
            acquisitionComplete: false,
          });
        }
        subjects.splice(first, subjects.length - first, {
          path: recorded.kind === 'readable' ? launchAdmissionPath(runDir, id) : directory,
          ...(recorded.kind === 'readable' ? { admission: recorded.admission } : {}),
          runDir,
          lifetimeDirectory: directory,
          branches,
          acquisitionComplete: false,
          problem: branches.length > 1 ? 'envelope-conflict' : (branches[0]?.problem ?? 'envelope-unavailable'),
        });
      }
    }
  } catch (error: unknown) {
    if (!isNoEntryError(error))
      subjects.push({
        path: root,
        runDir,
        lifetimeDirectory: root,
        branches: [],
        acquisitionComplete: false,
        problem: 'envelope-unavailable',
      });
  }
  for (const json of admissions) {
    if (json.kind === 'absent') continue;
    const path = json.kind === 'readable' ? launchAdmissionPath(runDir, json.admission.launchId) : json.path;
    if (subjects.some((subject) => subject.path === path)) continue;
    subjects.push({
      path,
      launchId: z.string().uuid().safeParse(basename(path, '.json')).data,
      ...(json.kind === 'readable' ? { admission: json.admission } : {}),
      acquisitionComplete: false,
      problem: 'envelope-unavailable',
    });
  }
  const attributed = [...subjects];
  for (let index = 0; index < subjects.length; index++) {
    const subject = subjects[index];
    if (subject.admission !== undefined || subject.launchId !== undefined || subject.branches !== undefined) continue;
    subjects[index] = {
      ...subject,
      runDir,
      lifetimeDirectory: subject.path,
      branches: attributed.filter((entry) => entry.path !== subject.path),
    };
  }
  return subjects;
}

/** Only the namespace owner repairs a damaged lock after excluding attributable live children. */
export function repairDamagedLaunchSubject(subject: LaunchSubject): void {
  if (subject.branches === undefined || subject.lifetimeDirectory === undefined) return;
  if (
    subject.branches.some(
      (branch) =>
        branch.admission !== undefined && observeLaunchSubject({ ...branch, lifetimePath: undefined }) !== 'absent',
    )
  )
    return;
  try {
    for (const entry of lifetimeDirectorySnapshot(subject.lifetimeDirectory)) {
      if (basename(entry.path) !== 'lifetime.lock') continue;
      const attempt = attemptExclusiveFileLockSync(entry.path);
      if (attempt.kind === 'acquired') attempt.lease();
      else if (attempt.kind === 'malformed') repairMalformedFileLockSync(entry.path);
    }
  } catch {
    // Unobservable lifetime evidence remains held for the next namespace pass.
  }
}

type LaunchSubjectDisposition = 'occupied' | 'acquisition-window' | 'unknown' | 'absent';

/** An exclusive probe before the first shared acquisition is not evidence of lease release. */
export function observeLaunchSubject(subject: LaunchSubject): LaunchSubjectDisposition {
  if (subject.branches !== undefined) {
    if (pendingLifetimeCleanups.has(subject.lifetimeDirectory)) return 'absent';
    if (subject.branches.some((branch) => observeLaunchSubject(branch) !== 'absent')) return 'unknown';
    return lifetimeDirectoryReleased(subject.lifetimeDirectory) ? 'absent' : 'unknown';
  }
  if (subject.admission === undefined) {
    if (subject.lifetimePath !== undefined) {
      const attempt = attemptExclusiveFileLockSync(subject.lifetimePath);
      if (attempt.kind !== 'acquired') return 'unknown';
      try {
        const current = lstatSync(subject.lifetimePath);
        return subject.inode?.dev === current.dev && subject.inode.ino === current.ino ? 'absent' : 'unknown';
      } catch {
        return 'unknown';
      } finally {
        attempt.lease();
      }
    }
    if (subject.launchId === undefined) return lifetimeDirectoryReleased(subject.path) ? 'absent' : 'unknown';
    try {
      lstatSync(join(dirname(dirname(subject.path)), 'launch-lifetimes.v1', subject.launchId));
      return 'unknown';
    } catch (error: unknown) {
      return isNoEntryError(error) ? 'absent' : 'unknown';
    }
  }
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
  if (subject.branches !== undefined) return removeAbsentLifetimeDirectory(subject);
  const launchId = subject.admission?.launchId ?? subject.launchId;
  if (launchId === undefined) return false;
  if (observeLaunchSubject(subject) !== 'absent') return false;
  const runDir = dirname(dirname(subject.path));
  const published = subject.lifetimeDirectory ?? join(runDir, 'launch-lifetimes.v1', launchId);
  const lifetimePath =
    subject.lifetimePath ??
    (subject.admission === undefined ? undefined : launchLifetimePath(runDir, subject.admission));
  try {
    const cleanupIncarnation = subject.admission === undefined ? probeProcessIncarnation(process.pid) : null;
    const cleanupChild =
      subject.admission?.child ??
      (cleanupIncarnation === null ? undefined : { pid: process.pid, incarnation: cleanupIncarnation });
    if (cleanupChild === undefined) return false;
    const temporary = launchPreparationPath(runDir, { launchId, child: cleanupChild });
    if (existsSync(published)) {
      const current = listLaunchSubjects(runDir).find((entry) => entry.lifetimePath === lifetimePath);
      if (
        current === undefined ||
        (subject.admission === undefined
          ? current.admission !== undefined || current.launchId !== launchId || current.problem === 'envelope-conflict'
          : current.admission === undefined || !sameEnvelope(current.admission, subject.admission)) ||
        observeLaunchSubject(current) !== 'absent'
      )
        return false;
    }
    let inode: ReturnType<typeof lstatSync> | undefined;
    try {
      if (lifetimePath !== undefined) inode = lstatSync(lifetimePath);
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
    let release: FileLockLease | undefined;
    if (inode !== undefined && lifetimePath !== undefined) {
      const expected = subject.inode ?? subject.admission?.lifetime;
      if (expected !== undefined && (inode.dev !== expected.dev || inode.ino !== expected.ino)) return false;
      const attempt = attemptExclusiveFileLockSync(lifetimePath);
      if (attempt.kind === 'acquired') release = attempt.lease;
      else if (
        attempt.kind !== 'malformed' ||
        observeLaunchSubject({ ...subject, lifetimePath: undefined }) !== 'absent'
      )
        return false;
    }
    try {
      if (inode !== undefined && lifetimePath !== undefined) {
        const current = lstatSync(lifetimePath);
        if (current.dev !== inode.dev || current.ino !== inode.ino) return false;
      }
      let jsonInode: ReturnType<typeof lstatSync> | undefined;
      try {
        jsonInode = lstatSync(subject.path);
      } catch (error: unknown) {
        if (!isNoEntryError(error)) throw error;
      }
      if (jsonInode !== undefined) {
        const json = readLaunchAdmission(runDir, launchId);
        if (
          json.kind === 'readable' &&
          (subject.admission === undefined || !sameEnvelope(json.admission, subject.admission)) &&
          (subject.conflictingAdmission === undefined || !sameEnvelope(json.admission, subject.conflictingAdmission))
        )
          return false;
        const checked = lstatSync(subject.path);
        if (checked.dev !== jsonInode.dev || checked.ino !== jsonInode.ino) return false;
        if (subject.admission === undefined && lifetimePath === undefined && observeLaunchSubject(subject) !== 'absent')
          return false;
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
