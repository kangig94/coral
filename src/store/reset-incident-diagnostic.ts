import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  MAX_SQLITE_DIAGNOSTIC_BYTES,
  SQLITE_CHILD_STDERR_MAX_BYTES,
  SQLITE_CHILD_STDOUT_MAX_BYTES,
  SQLITE_EXECUTION_DEADLINE_MS,
  SQLITE_FORCE_CLOSE_DEADLINE_MS,
  SQLITE_TERMINATION_GRACE_MS,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifest,
} from './reset-incident.js';
import {
  sameStoreResetInspectionIdentity,
  type StoreResetFileDescriptor,
  type StoreResetInspectionFs,
  type StoreResetInspectionStat,
} from './reset-incident-inspection-fs.js';

const DIAGNOSTIC_SOURCE_NAMES = ['store.db', 'store.db-wal', 'store.db-shm'] as const;
const COPY_BUFFER_BYTES = 64 * 1024;

const SQLITE_DIAGNOSTIC_PROGRAM = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = process.argv[1];
let db;
let token = 'unavailable';
try {
  db = new DatabaseSync(path, { readOnly: true, timeout: 100 });
  db.exec('PRAGMA query_only = ON');
  const rows = db.prepare('PRAGMA quick_check(1)').all();
  token = rows.length === 1 && Object.values(rows[0])[0] === 'ok' ? 'ok' : 'failed';
} catch {
  token = 'unavailable';
} finally {
  try { db?.close(); } catch { token = 'unavailable'; }
}
process.stdout.write(token);
`;

export type StoreResetDiagnosticStatus = StoreResetIncidentLocalReport['diagnostic'];

export interface StoreResetDiagnosticChild {
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: () => void): void;
  terminate(force: boolean): void;
  destroyPipes(): void;
  dispose(): void;
  unref(): void;
}

export interface StoreResetDiagnosticSupervisorPort {
  readonly signal?: AbortSignal;
  spawn(executable: string, args: readonly string[]): StoreResetDiagnosticChild;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type StoreResetIncidentDiagnosticRunner = (options: {
  readonly fs: StoreResetInspectionFs;
  readonly incidentPath: string;
  readonly manifest: StoreResetIncidentManifest;
}) => Promise<StoreResetDiagnosticStatus>;

export function superviseStoreResetDiagnosticChild(
  supervisor: StoreResetDiagnosticSupervisorPort,
  executable: string,
  stagedDbPath: string,
): Promise<{
  readonly integrity: StoreResetDiagnosticStatus['integrity'];
  readonly termination: StoreResetDiagnosticStatus['termination'];
}> {
  return new Promise((resolve) => {
    let child: StoreResetDiagnosticChild;
    try {
      child = supervisor.spawn(executable, [
        '--input-type=commonjs',
        '--eval',
        SQLITE_DIAGNOSTIC_PROGRAM,
        stagedDbPath,
      ]);
    } catch {
      resolve({ integrity: 'unavailable', termination: 'not_started' });
      return;
    }

    let finished = false;
    let terminating = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Uint8Array[] = [];
    const timers = new Set<unknown>();

    const schedule = (callback: () => void, milliseconds: number): void => {
      const slot: { handle?: unknown } = {};
      slot.handle = supervisor.setTimeout(() => {
        if (slot.handle !== undefined) timers.delete(slot.handle);
        callback();
      }, milliseconds);
      if (!finished) timers.add(slot.handle);
    };
    const finish = (
      integrity: StoreResetDiagnosticStatus['integrity'],
      termination: StoreResetDiagnosticStatus['termination'],
      detach = false,
    ): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) supervisor.clearTimeout(timer);
      timers.clear();
      if (abortListener !== null) {
        supervisor.signal?.removeEventListener('abort', abortListener);
        abortListener = null;
      }
      child.dispose();
      if (detach) {
        child.destroyPipes();
        child.unref();
      }
      resolve({ integrity, termination });
    };
    const forceTermination = (): void => {
      if (finished) return;
      child.terminate(true);
      schedule(() => {
        finish('unavailable', 'termination_unconfirmed', true);
      }, SQLITE_FORCE_CLOSE_DEADLINE_MS);
    };
    const beginTermination = (): void => {
      if (finished || terminating) return;
      terminating = true;
      child.terminate(false);
      schedule(forceTermination, SQLITE_TERMINATION_GRACE_MS);
    };
    let abortListener: (() => void) | null = () => beginTermination();

    child.onStdout((chunk) => {
      if (finished) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > SQLITE_CHILD_STDOUT_MAX_BYTES) {
        child.destroyPipes();
        beginTermination();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.onStderr((chunk) => {
      if (finished) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > SQLITE_CHILD_STDERR_MAX_BYTES) {
        child.destroyPipes();
        beginTermination();
      }
    });
    child.onError(() => {
      beginTermination();
    });
    child.onClose((code, signal) => {
      if (finished) return;
      if (terminating) {
        finish('unavailable', 'terminated');
        return;
      }
      const token = Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
      if (code !== 0 || signal !== null || stderrBytes !== 0) {
        finish('unavailable', 'completed');
        return;
      }
      if (token === 'ok' || token === 'failed' || token === 'unavailable') {
        finish(token, 'completed');
        return;
      }
      finish('unavailable', 'completed');
    });
    if (supervisor.signal?.aborted) {
      beginTermination();
    } else if (supervisor.signal !== undefined) {
      supervisor.signal.addEventListener('abort', abortListener, { once: true });
    }
    schedule(beginTermination, SQLITE_EXECUTION_DEADLINE_MS);
  });
}

function closeDescriptors(fs: StoreResetInspectionFs, descriptors: readonly (StoreResetFileDescriptor | null)[]): void {
  let failed = false;
  for (const descriptor of descriptors) {
    if (descriptor === null) continue;
    try {
      fs.close(descriptor);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('descriptor close failed');
}

function copyEvidence(options: {
  readonly fs: StoreResetInspectionFs;
  readonly source: string;
  readonly destination: string;
  readonly remainingBudget: number;
  readonly platform: string;
}): { readonly bytes: number; readonly sha256: string } {
  const before = options.fs.lstat(options.source);
  if (before === null || before.kind !== 'file' || before.size > BigInt(options.remainingBudget)) {
    throw new Error('source unavailable');
  }
  let sourceDescriptor: StoreResetFileDescriptor | null = null;
  let destinationDescriptor: StoreResetFileDescriptor | null = null;
  let failure: unknown = null;
  let result: { readonly bytes: number; readonly sha256: string } | null = null;
  try {
    sourceDescriptor = options.fs.open(options.source, options.fs.openFlags.readOnly);
    const opened = options.fs.fstat(sourceDescriptor);
    if (!sameStoreResetInspectionIdentity(before, opened) || opened.kind !== 'file') {
      throw new Error('source identity changed');
    }
    destinationDescriptor = options.fs.open(options.destination, options.fs.openFlags.createExclusiveWrite, 0o600);
    const destinationStat = options.fs.fstat(destinationDescriptor);
    if (
      destinationStat.kind !== 'file' ||
      (options.platform !== 'win32' && (destinationStat.mode & 0o777n) !== 0o600n)
    ) {
      throw new Error('destination is not private');
    }

    const expectedBytes = Number(opened.size);
    const buffer = new Uint8Array(COPY_BUFFER_BYTES);
    const hash = createHash('sha256');
    let readOffset = 0;
    let writeOffset = 0;
    while (readOffset < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - readOffset);
      const read = options.fs.read(sourceDescriptor, buffer, 0, requested, readOffset);
      if (read <= 0 || read > requested) throw new Error('source read failed');
      hash.update(buffer.subarray(0, read));
      let chunkOffset = 0;
      while (chunkOffset < read) {
        const written = options.fs.write(destinationDescriptor, buffer, chunkOffset, read - chunkOffset, writeOffset);
        if (written <= 0 || written > read - chunkOffset) throw new Error('destination write failed');
        chunkOffset += written;
        writeOffset += written;
      }
      readOffset += read;
    }
    if (options.fs.read(sourceDescriptor, buffer, 0, 1, readOffset) !== 0) {
      throw new Error('source grew during copy');
    }
    const after = options.fs.lstat(options.source);
    if (after === null || !sameStoreResetInspectionIdentity(opened, after)) {
      throw new Error('source identity changed');
    }
    result = { bytes: readOffset, sha256: hash.digest('hex') };
  } catch (error: unknown) {
    failure = error;
  }
  try {
    closeDescriptors(options.fs, [destinationDescriptor, sourceDescriptor]);
  } catch (error: unknown) {
    failure = error;
  }
  if (failure !== null || result === null) throw new Error('copy unavailable');
  return result;
}

function hashEvidence(
  fs: StoreResetInspectionFs,
  path: string,
  remainingBudget: number,
): { readonly bytes: number; readonly sha256: string } {
  const before = fs.lstat(path);
  if (before === null || before.kind !== 'file' || before.size > BigInt(remainingBudget)) {
    throw new Error('source unavailable');
  }
  let descriptor: StoreResetFileDescriptor | null = null;
  let failure: unknown = null;
  let result: { readonly bytes: number; readonly sha256: string } | null = null;
  try {
    descriptor = fs.open(path, fs.openFlags.readOnly);
    const opened = fs.fstat(descriptor);
    if (!sameStoreResetInspectionIdentity(before, opened)) throw new Error('source identity changed');
    const expectedBytes = Number(opened.size);
    const buffer = new Uint8Array(COPY_BUFFER_BYTES);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - offset);
      const read = fs.read(descriptor, buffer, 0, requested, offset);
      if (read <= 0 || read > requested) throw new Error('source read failed');
      offset += read;
      hash.update(buffer.subarray(0, read));
    }
    if (fs.read(descriptor, buffer, 0, 1, offset) !== 0) throw new Error('source grew');
    const after = fs.lstat(path);
    if (after === null || !sameStoreResetInspectionIdentity(opened, after)) {
      throw new Error('source identity changed');
    }
    result = { bytes: offset, sha256: hash.digest('hex') };
  } catch (error: unknown) {
    failure = error;
  }
  try {
    closeDescriptors(fs, [descriptor]);
  } catch (error: unknown) {
    failure = error;
  }
  if (failure !== null || result === null) throw new Error('hash unavailable');
  return result;
}

export function createStoreResetIncidentDiagnosticRunner(options: {
  readonly tempRoot: string;
  readonly platform: string;
  readonly executable: string;
  readonly supervisor: StoreResetDiagnosticSupervisorPort;
}): StoreResetIncidentDiagnosticRunner {
  return async ({ fs, incidentPath, manifest }) => {
    const evidence = DIAGNOSTIC_SOURCE_NAMES.flatMap((name) => {
      const entry = manifest.files.find((file) => file.name === name);
      return entry === undefined ? [] : [{ name, entry }];
    });
    if (evidence.length === 0 || evidence[0]?.name !== 'store.db') {
      return {
        integrity: 'unavailable',
        termination: 'not_started',
        cleanup: 'not_required',
      };
    }
    if (evidence.reduce((total, item) => total + item.entry.sizeBytes, 0) > MAX_SQLITE_DIAGNOSTIC_BYTES) {
      return {
        integrity: 'unavailable',
        termination: 'not_started',
        cleanup: 'not_required',
      };
    }

    let tempDirectory: string | null = null;
    let tempIdentity: StoreResetInspectionStat | null = null;
    let tempRealPath: string | null = null;
    let supervision: Awaited<ReturnType<typeof superviseStoreResetDiagnosticChild>> | null = null;
    const cleanup = (): StoreResetDiagnosticStatus['cleanup'] => {
      if (tempDirectory === null) {
        return 'not_required';
      }
      if (tempIdentity === null || tempRealPath === null) return 'cleanup_unavailable';
      try {
        if (fs.realpath(tempDirectory) !== tempRealPath) return 'cleanup_unavailable';
        return fs.removeTreeGuarded(tempDirectory, tempIdentity) ? 'removed' : 'cleanup_unavailable';
      } catch {
        return 'cleanup_unavailable';
      }
    };

    try {
      tempDirectory = fs.mkdtemp(join(options.tempRoot, 'coral-store-reset-'));
      tempIdentity = fs.lstat(tempDirectory);
      if (
        tempIdentity === null ||
        tempIdentity.kind !== 'directory' ||
        (options.platform !== 'win32' && (tempIdentity.mode & 0o777n) !== 0o700n)
      ) {
        throw new Error('temporary directory is not private');
      }
      tempRealPath = fs.realpath(tempDirectory);

      let remaining = MAX_SQLITE_DIAGNOSTIC_BYTES;
      const sourceHashes = new Map<string, string>();
      for (const { name, entry } of evidence) {
        const copied = copyEvidence({
          fs,
          source: join(incidentPath, name),
          destination: join(tempDirectory, name),
          remainingBudget: remaining,
          platform: options.platform,
        });
        if (copied.bytes !== entry.sizeBytes || copied.sha256 !== entry.sha256) {
          throw new Error('source differs from manifest');
        }
        remaining -= copied.bytes;
        sourceHashes.set(name, copied.sha256);
      }

      supervision = await superviseStoreResetDiagnosticChild(
        options.supervisor,
        options.executable,
        join(tempDirectory, 'store.db'),
      );

      let verificationRemaining = MAX_SQLITE_DIAGNOSTIC_BYTES;
      for (const { name } of evidence) {
        const verified = hashEvidence(fs, join(incidentPath, name), verificationRemaining);
        if (verified.sha256 !== sourceHashes.get(name)) {
          throw new Error('source changed during diagnostic');
        }
        verificationRemaining -= verified.bytes;
      }
      if (supervision.termination === 'termination_unconfirmed') {
        return {
          integrity: 'unavailable',
          termination: 'termination_unconfirmed',
          cleanup: 'cleanup_unavailable',
        };
      }

      const cleanupState = cleanup();
      return {
        integrity: cleanupState === 'removed' ? supervision.integrity : 'unavailable',
        termination: supervision.termination,
        cleanup: cleanupState,
      };
    } catch {
      return {
        integrity: 'unavailable',
        termination: supervision?.termination ?? 'not_started',
        cleanup: supervision?.termination === 'termination_unconfirmed' ? 'cleanup_unavailable' : cleanup(),
      };
    }
  };
}
