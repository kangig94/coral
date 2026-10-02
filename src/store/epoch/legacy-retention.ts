import { join } from 'node:path';
import { attemptExclusiveFileLockSync } from '../../infra/fs-lock.js';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { readActiveStoreSelectionForCoordination } from '../active-store-selection.js';
import { readSuccessionWriterGeneration } from '../succession-writer-generation.js';
import type { RetentionOutcome } from '../retention-outcome.js';
import { inspectCurrentStore, resolveCurrentStore } from './observation.js';

/** Idle SQLite handles may hold no transaction lock; absence also requires a complete descriptor observation. */
function legacyHandlesAbsent(runtime: Runtime, paths: readonly string[], canContinue: () => boolean): boolean {
  if (runtime.env.platform() !== 'linux') return false;
  const identities = paths.map((path) => runtime.storage.lstatSync(path, { bigint: true }));
  const processes = runtime.storage.readDirectoryBoundedSync('/proc', 20_000);
  if (processes.overflow) return false;
  for (const pid of processes.entries.filter((entry) => /^\d+$/u.test(entry))) {
    if (!canContinue()) return false;
    try {
      const root = `/proc/${pid}/fd`;
      const fds = runtime.storage.readDirectoryBoundedSync(root, 20_000);
      if (fds.overflow) return false;
      for (const fd of fds.entries) {
        if (!canContinue()) return false;
        try {
          const identity = runtime.storage.statSync(join(root, fd), { bigint: true });
          if (identities.some(({ dev, ino }) => dev === identity.dev && ino === identity.ino)) return false;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
      }
    } catch {
      if (runtime.process.observeLiveness(Number(pid)) !== 'absent') return false;
    }
  }
  return true;
}

export function removeLegacyStore(runtime: Runtime, canContinue: () => boolean): RetentionOutcome {
  const root = runtime.paths.coral.store.dbDir;
  const subject = join(root, 'store.db');
  const keep = (reason: string): RetentionOutcome => ({ kind: 'kept', subject, reason });
  let deleting = false;
  try {
    if (!canContinue()) return keep('run-interrupted');
    const current = inspectCurrentStore(runtime);
    const active = resolveCurrentStore(runtime);
    const selection = readActiveStoreSelectionForCoordination(runtime);
    const writer = readSuccessionWriterGeneration(runtime);
    if (current.kind !== 'current' || active.epoch === null || active.path !== current.epoch.path)
      return keep('current-epoch-unproven');
    if (
      selection.kind !== 'valid' ||
      writer.kind !== 'recorded' ||
      writer.record.epoch !== current.epoch.epoch ||
      writer.record.storeRoot !== current.epoch.storeRoot
    )
      return keep('active-selection-unknown-or-legacy');
    const entries = runtime.storage.readDirectoryBoundedSync(root, 10_000);
    if (entries.overflow) return keep('legacy-enumeration-bound');
    const paths = entries.entries
      .filter((name) => /^store\.db(?:-wal|-shm|\.format|(?:\..*)?\.bak)?$/u.test(name))
      .map((name) => join(root, name));
    if (paths.length === 0) return keep('legacy-absent');
    if (
      paths.some((path) => {
        const entry = runtime.storage.lstatSync(path);
        return !entry.isFile() || entry.isSymbolicLink();
      })
    )
      return keep('legacy-files-unproven');
    if (!legacyHandlesAbsent(runtime, paths, canContinue)) return keep('legacy-holder-alive-or-unknown');
    const lock = attemptExclusiveFileLockSync(subject, 0, true);
    if (lock.kind !== 'acquired') return keep(`legacy-lock-${lock.kind}`);
    try {
      if (!canContinue()) return keep('run-interrupted');
      deleting = true;
      for (const path of paths.filter((path) => path !== subject)) runtime.storage.unlinkSync(path);
      runtime.storage.unlinkSync(subject);
      if (!runtime.storage.syncDirectoryDurableSync(root))
        return { kind: 'failed', subject, reason: 'legacy-directory-sync-failed' };
      return { kind: 'deleted', subject, count: paths.length };
    } finally {
      lock.lease();
    }
  } catch (error: unknown) {
    return { kind: deleting ? 'failed' : 'kept', subject, reason: errorMessage(error) };
  }
}
