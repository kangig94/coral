import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { readActiveStoreSelectionForCoordination } from '../active-store-selection.js';
import { readSuccessionWriterGeneration } from '../succession-writer-generation.js';
import type { RetentionOutcome } from '../retention-outcome.js';
import { observeStoreEpoch } from './observation.js';

/** Retire only an expired flat-store family beside a proven current epoch. */
export async function removeLegacyStore(
  runtime: Runtime,
  canContinue: () => boolean,
  cutoff: number,
  mutate: <T>(operation: () => T) => T,
  afterName = '',
  checkpoint: (nextName: string) => void = () => {},
): Promise<RetentionOutcome> {
  const root = runtime.paths.coral.store.dbDir;
  const subject = join(root, 'store.db');
  const keep = (reason: string): RetentionOutcome => ({ kind: 'kept', subject, reason });
  let deleting = false;
  let recoveryFailed = false;
  try {
    if (!canContinue()) return keep('run-interrupted');
    const selection = readActiveStoreSelectionForCoordination(runtime);
    const writer = readSuccessionWriterGeneration(runtime);
    const storeRoot = runtime.storage.realpathSync(root);
    if (selection.kind !== 'valid' || writer.kind !== 'recorded' || writer.record.storeRoot !== storeRoot)
      return keep('active-selection-unknown-or-legacy');
    if (observeStoreEpoch(runtime.storage, storeRoot, `epoch-${writer.record.epoch}`)?.proof.kind !== 'proven')
      return keep('current-epoch-unproven');
    const family = /^store\.db(?:-wal|-shm|\.format|(?:\..*)?\.bak)?$/u;
    const prefix = '.legacy-retention-';
    const quarantine = join(root, prefix + 'family');
    const isFamily = (name: string): boolean => family.test(name.startsWith(prefix) ? name.slice(prefix.length) : name);
    const expired = (path: string): boolean => {
      const entry = runtime.storage.lstatSync(path, { bigint: true });
      return entry.isFile() && entry.mtimeNs < BigInt(Math.floor(cutoff)) * 1_000_000n;
    };
    const files = new Map<string, string>();
    let quarantined = false;
    try {
      const entry = runtime.storage.lstatSync(quarantine);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return keep('legacy-quarantine-unproven');
      quarantined = true;
      for await (const name of runtime.storage.iterateDirectory(quarantine)) {
        if (!canContinue()) return keep('scan-pending');
        if (!isFamily(name)) return keep('legacy-quarantine-unproven');
        files.set(name, join(quarantine, name));
        await setImmediate();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for await (const name of runtime.storage.iterateDirectory(root)) {
      if (!canContinue()) return keep('scan-pending');
      if (isFamily(name)) {
        if (files.has(name) || !expired(join(root, name))) return keep('legacy-not-expired-or-unknown');
        files.set(name, join(root, name));
      }
      await setImmediate();
    }
    if (!canContinue()) return keep('scan-pending');
    // A sibling may have appeared while the directory scan yielded.
    for (const suffix of ['', '-wal', '-shm', '.format']) {
      const name = 'store.db' + suffix;
      const path = join(root, name);
      try {
        if (!expired(path)) return keep('legacy-not-expired-or-unknown');
        if (files.has(name) && files.get(name) !== path) return keep('legacy-family-conflict');
        files.set(name, path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (files.size === 0) {
      if (quarantined) mutate(() => runtime.storage.rmdirSync(quarantine));
      checkpoint('');
      return { kind: 'kept', subject, reason: 'legacy-absent', pending: false };
    }
    const moved = [...files].filter(([name, path]) => path === join(quarantine, name)).map(([name]) => name);
    mutate(() => {
      if (!quarantined) runtime.storage.mkdirSync(quarantine);
      try {
        const familyNames = new Set(['store.db', 'store.db-wal', 'store.db-shm', 'store.db.format', ...files.keys()]);
        for (const name of familyNames) {
          let path = files.get(name);
          if (path === undefined) {
            path = join(root, name);
            try {
              runtime.storage.lstatSync(path);
              files.set(name, path);
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              continue;
            }
          }
          const destination = join(quarantine, name);
          if (path !== destination) {
            runtime.storage.renameSync(path, destination);
            moved.push(name);
          }
        }
        if (!runtime.storage.syncDirectoryDurableSync(quarantine) || !runtime.storage.syncDirectoryDurableSync(root))
          throw new Error('legacy-quarantine-sync-failed');
        for (const name of files.keys()) {
          if (!expired(join(quarantine, name))) throw new Error('legacy-not-expired-or-unknown');
        }
        if (!canContinue()) throw new Error('scan-pending');
      } catch (error: unknown) {
        try {
          for (const name of moved.reverse()) {
            try {
              runtime.storage.lstatSync(join(root, name));
              throw new Error('legacy-restore-path-occupied', { cause: error });
            } catch (probe: unknown) {
              if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe;
            }
            runtime.storage.renameSync(join(quarantine, name), join(root, name));
          }
          runtime.storage.rmdirSync(quarantine);
          if (!runtime.storage.syncDirectoryDurableSync(root))
            throw new Error('legacy-restore-sync-failed', { cause: error });
        } catch (restoreError: unknown) {
          recoveryFailed = true;
          throw restoreError;
        }
        throw error;
      }
    });
    const names = [...files.keys()];
    const start = Math.max(0, names.indexOf(afterName));
    const ordered = [...names.slice(start), ...names.slice(0, start)].sort(
      (a, b) =>
        Number(b === 'store.db' || b === prefix + 'store.db') - Number(a === 'store.db' || a === prefix + 'store.db'),
    );
    let count = 0;
    for (const name of ordered) {
      if (!canContinue()) {
        checkpoint(name);
        return keep('scan-pending');
      }
      deleting = true;
      mutate(() => {
        runtime.storage.unlinkSync(join(quarantine, name));
        if (!runtime.storage.syncDirectoryDurableSync(quarantine)) throw new Error('legacy-directory-sync-failed');
      });
      count += 1;
      checkpoint('');
      await setImmediate();
    }
    mutate(() => {
      runtime.storage.rmdirSync(quarantine);
      if (!runtime.storage.syncDirectoryDurableSync(root)) throw new Error('legacy-directory-sync-failed');
    });
    return { kind: 'deleted', subject, count };
  } catch (error: unknown) {
    return { kind: deleting || recoveryFailed ? 'failed' : 'kept', subject, reason: errorMessage(error) };
  }
}
