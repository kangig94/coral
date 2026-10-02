import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { readActiveStoreSelectionForCoordination } from '../active-store-selection.js';
import { readSuccessionWriterGeneration } from '../succession-writer-generation.js';
import type { RetentionOutcome } from '../retention-outcome.js';
import { observeStoreEpoch } from './observation.js';

/** Serving owns every shipped namespace socket; a pre-epoch coordinator cannot also serve or write. */
export async function removeLegacyStore(
  runtime: Runtime,
  canContinue: () => boolean,
  hasNamespaceAuthority: () => boolean,
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
    if (!hasNamespaceAuthority()) return keep('namespace-authority-unproven');
    const selection = readActiveStoreSelectionForCoordination(runtime);
    const writer = readSuccessionWriterGeneration(runtime);
    const storeRoot = runtime.storage.realpathSync(root);
    if (selection.kind !== 'valid' || writer.kind !== 'recorded' || writer.record.storeRoot !== storeRoot)
      return keep('active-selection-unknown-or-legacy');
    if (observeStoreEpoch(runtime.storage, storeRoot, `epoch-${writer.record.epoch}`)?.proof.kind !== 'proven')
      return keep('current-epoch-unproven');
    const family = /^store\.db(?:-wal|-shm|\.format|(?:\..*)?\.bak)?$/u;
    const prefix = '.legacy-retention-';
    let count = 0;
    const retire = (name: string): void => {
      if (!canContinue() || !hasNamespaceAuthority()) throw new Error('scan-pending');
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
    let resume = afterName !== '';
    const iterator = runtime.storage.iterateDirectory(root)[Symbol.asyncIterator]();
    try {
      let currentEntry = await iterator.next();
      while (!currentEntry.done) {
        const name = currentEntry.value;
        if (!canContinue()) {
          checkpoint(name);
          return keep('scan-pending');
        }
        if (resume && name !== afterName) {
          currentEntry = await iterator.next();
          await setImmediate();
          continue;
        }
        resume = false;
        const originalName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
        if (originalName !== 'store.db' && family.test(originalName)) retire(name);
        currentEntry = await iterator.next();
        checkpoint(currentEntry.done ? '' : currentEntry.value);
        await setImmediate();
      }
      checkpoint('');
      if (resume) return keep('scan-pending');
    } finally {
      await iterator.return?.();
    }
    return count > 0 ? { kind: 'deleted', subject, count } : keep('legacy-absent');
  } catch (error: unknown) {
    return { kind: deleting ? 'failed' : 'kept', subject, reason: errorMessage(error) };
  }
}
