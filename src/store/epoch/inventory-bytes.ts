import { type StoragePort } from '../../infra/port-types.js';
import { join } from 'node:path';
import { type StoreEpoch } from './types.js';
import { epochDirectory } from './observation.js';

export function entryBytes(storage: StoragePort, root: string): number | null {
  let total = 0;
  const inventory = (path: string): boolean => {
    const entry = storage.lstatSync(path, { bigint: true });
    if (entry.isDirectory()) {
      for (const child of storage.readdirSync(path)) {
        if (!inventory(join(path, child))) return false;
      }
      return true;
    }
    if (entry.size < 0n || entry.size > BigInt(Number.MAX_SAFE_INTEGER - total)) return false;
    total += Number(entry.size);
    return true;
  };
  try {
    return inventory(root) ? total : null;
  } catch {
    return null;
  }
}

export function epochBytes(storage: StoragePort, dbDir: string, epoch: StoreEpoch): number | null {
  return entryBytes(storage, epochDirectory(dbDir, epoch));
}
