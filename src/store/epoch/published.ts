import { type Runtime } from '../../runtime/ports.js';
import { type FileLockLease } from '../../infra/fs-lock.js';
import {
  observeSuccessionWriterGeneration,
  advanceSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
} from '../succession-writer-generation.js';
import { openStoreDatabase } from '../db.js';
import { type StoragePort } from '../../infra/port-types.js';
import { type StoreEpochOptions, type StoreEpoch, type StoreEpochSettlement } from './types.js';
import { resolvedStoreEpoch } from './observation.js';
import { registerStoreEpochHolder } from './holder.js';
import { errorCode } from './classification.js';

export function openPublishedEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  predecessor: StoreEpoch | null,
  epoch: StoreEpoch,
  lease: FileLockLease,
): StoreEpochSettlement {
  const resolved = resolvedStoreEpoch(dbDir, epoch);
  try {
    const generation = observeSuccessionWriterGeneration(runtime);
    if (generation !== null && generation.epoch !== epoch) {
      if (generation.storeRoot !== dbDir || predecessor === null || BigInt(generation.epoch) > BigInt(predecessor)) {
        throw new Error(`Store epoch ${epoch} cannot inherit an unrelated succession writer generation.`);
      }
      advanceSuccessionWriterGeneration(runtime, generation, { storeRoot: dbDir, epoch });
    }
    assertProvenStoreOpenable(runtime.storage, resolved.path);
    const db = openStoreDatabase({
      path: resolved.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
      writerEntitlement: joinSuccessionWriterGeneration(runtime, {
        storeRoot: resolved.canonicalStoreRoot ?? resolved.storeRoot,
        epoch: resolved.epoch,
      }),
    });
    db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
    return { db: registerStoreEpochHolder(runtime, resolved, db, lease), store: resolved };
  } catch (error: unknown) {
    lease();
    throw error;
  }
}

/** A writer generation left on an older epoch of this store root follows the proven current epoch forward, never back. */
export function advanceWriterGenerationToProvenEpoch(runtime: Runtime, dbDir: string, epoch: StoreEpoch): void {
  const generation = observeSuccessionWriterGeneration(runtime);
  if (
    generation === null ||
    generation.storeRoot !== dbDir ||
    !/^[1-9]\d*$/u.test(generation.epoch) ||
    BigInt(generation.epoch) >= BigInt(epoch)
  ) {
    return;
  }
  advanceSuccessionWriterGeneration(runtime, generation, { storeRoot: dbDir, epoch });
}

export function assertProvenStoreOpenable(storage: StoragePort, path: string): void {
  let descriptor: number;
  try {
    descriptor = storage.openSync(path, 'r+');
  } catch (error: unknown) {
    if (error instanceof Error) {
      error.message = `The open syscall for proven store epoch '${path}' was refused with errno ${errorCode(error) ?? 'UNKNOWN'}: ${error.message}`;
    }
    throw error;
  }
  try {
    storage.closeSync(descriptor);
  } catch {
    /* best-effort probe cleanup */
  }
}
