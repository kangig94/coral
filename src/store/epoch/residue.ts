import { type Runtime } from '../../runtime/ports.js';
import { join } from 'node:path';
import {
  MINT_DIRECTORY_PREFIX,
  MINT_PREPARATION_DIRECTORY_PREFIX,
  PRIVATE_MINT_CONSTRUCTION_PREFIX,
  REAPING_DIRECTORY_PREFIX,
  RETAINED_REAPING_DIRECTORY_PREFIX,
} from './constants.js';
import { type StoreEpochResidueListEntry } from './types.js';
import { resolveObservedStoreRoot, observeContainedDirectory } from './observation.js';
import { entryBytes } from './inventory-bytes.js';

export function isStoreEpochResidue(name: string): boolean {
  return (
    name.startsWith(MINT_DIRECTORY_PREFIX) ||
    name.startsWith(MINT_PREPARATION_DIRECTORY_PREFIX) ||
    name.startsWith(PRIVATE_MINT_CONSTRUCTION_PREFIX) ||
    name.startsWith(REAPING_DIRECTORY_PREFIX)
  );
}

export function listStoreEpochResidues(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): readonly StoreEpochResidueListEntry[] {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  let root: ReturnType<typeof resolveObservedStoreRoot>;
  try {
    root = resolveObservedStoreRoot(runtime.storage, configuredDbDir);
  } catch {
    return [{ name: 'unobservable', bytes: null, state: 'unobservable' }];
  }
  if (root.kind === 'absent') return [];
  const dbDir = root.path;
  let entries: readonly string[];
  try {
    entries = runtime.storage.readdirSync(dbDir);
  } catch {
    return [{ name: 'unobservable', bytes: null, state: 'unobservable' }];
  }
  return entries
    .filter((name) => isStoreEpochResidue(name) || name.startsWith(RETAINED_REAPING_DIRECTORY_PREFIX))
    .sort()
    .map((name) => {
      const path = join(dbDir, name);
      const root = observeContainedDirectory(runtime.storage, dbDir, path);
      let state: StoreEpochResidueListEntry['state'];
      if (name.startsWith(RETAINED_REAPING_DIRECTORY_PREFIX)) {
        state = root.kind === 'proven' ? 'retained' : 'unobservable';
      } else if (root.kind === 'unobservable' || root.kind === 'proven') {
        state = 'unobservable';
      } else {
        state = 'reclaimable';
      }
      return { name, bytes: entryBytes(runtime.storage, path), state };
    });
}
