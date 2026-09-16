import type { StoragePort } from '../infra/port-types.js';

export type StorePathObservation = 'present' | 'absent';

export function observeStorePath(storage: Pick<StoragePort, 'lstatSync'>, path: string): StorePathObservation {
  try {
    storage.lstatSync(path);
    return 'present';
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}
