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
    const expired = (name: string): boolean => {
      const entry = runtime.storage.lstatSync(join(root, name), { bigint: true });
      return entry.isFile() && entry.mtimeNs < BigInt(Math.floor(cutoff)) * 1_000_000n;
    };
    const names: string[] = [];
    for await (const name of runtime.storage.iterateDirectory(root)) {
      if (!canContinue()) return keep('scan-pending');
      const originalName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
      if (family.test(originalName)) {
        if (!expired(name)) return keep('legacy-not-expired-or-unknown');
        names.push(name);
      }
      await setImmediate();
    }
    if (!canContinue()) return keep('scan-pending');
    if (!names.every(expired)) return keep('legacy-not-expired-or-unknown');
    for (const suffix of ['', '-wal', '-shm', '.format']) {
      try {
        if (!expired('store.db' + suffix)) return keep('legacy-not-expired-or-unknown');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    let count = 0;
    const retire = (name: string): void => {
      if (!canContinue()) throw new Error('scan-pending');
      if (!expired(name)) throw new Error('legacy-not-expired-or-unknown');
      const path = join(root, name);
      const entry = runtime.storage.lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('legacy-files-unproven');
      deleting = true;
      mutate(() => {
        const quarantine = name.startsWith(prefix) ? path : join(root, prefix + name);
        if (quarantine !== path) runtime.storage.renameSync(path, quarantine);
        if (!runtime.storage.syncDirectoryDurableSync(root)) throw new Error('legacy-quarantine-sync-failed');
        runtime.storage.unlinkSync(quarantine);
        if (!runtime.storage.syncDirectoryDurableSync(root)) throw new Error('legacy-directory-sync-failed');
      });
      count += 1;
    };
    // The main pathname is retired before any sibling or yield, including after an interrupted scan.
    for (const name of [prefix + 'store.db', 'store.db']) {
      try {
        retire(name);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const siblings = names.filter((name) => name !== 'store.db' && name !== prefix + 'store.db');
    const start = afterName === '' ? 0 : siblings.indexOf(afterName);
    if (start < 0) {
      checkpoint('');
      return keep('scan-pending');
    }
    for (let index = start; index < siblings.length; index += 1) {
      const name = siblings[index];
      if (!canContinue()) {
        checkpoint(name);
        return keep('scan-pending');
      }
      retire(name);
      checkpoint(siblings[index + 1] ?? '');
      await setImmediate();
    }
    checkpoint('');
    return count > 0 ? { kind: 'deleted', subject, count } : keep('legacy-absent');
  } catch (error: unknown) {
    return { kind: deleting ? 'failed' : 'kept', subject, reason: errorMessage(error) };
  }
}
