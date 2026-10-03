import { dirname, join } from 'node:path';
import type { StorageBigIntStat, StoragePort } from './port-types.js';

export type TreeRemovalStorage = Pick<StoragePort, 'lstatSync' | 'readdirSync' | 'rmdirSync' | 'unlinkSync'>;

export function removeTreeNoFollowSync(storage: TreeRemovalStorage, path: string): void {
  const directories = new Map<string, StorageBigIntStat>();
  const parent = dirname(path);
  const parentEntry = storage.lstatSync(parent, { bigint: true });
  if (!parentEntry.isDirectory()) throw new Error(`Tree removal parent is not a directory: ${parent}`);
  directories.set(parent, parentEntry);
  const assertIdentity = (candidate: string, expected: StorageBigIntStat): void => {
    const current = storage.lstatSync(candidate, { bigint: true });
    if (current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode)
      throw new Error(`Tree removal entry identity changed: ${candidate}`);
  };
  const assertParents = (candidate: string): void => {
    let parent = dirname(candidate);
    let expected = directories.get(parent);
    while (expected !== undefined) {
      assertIdentity(parent, expected);
      parent = dirname(parent);
      expected = directories.get(parent);
    }
  };
  const remove = (candidate: string, entry: StorageBigIntStat): void => {
    assertParents(candidate);
    assertIdentity(candidate, entry);
    if (entry.isDirectory()) {
      directories.set(candidate, entry);
      for (const child of storage.readdirSync(candidate)) {
        assertIdentity(candidate, entry);
        const childPath = join(candidate, child);
        let childEntry: StorageBigIntStat;
        try {
          childEntry = storage.lstatSync(childPath, { bigint: true });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        remove(childPath, childEntry);
      }
      assertParents(candidate);
      assertIdentity(candidate, entry);
      storage.rmdirSync(candidate);
      directories.delete(candidate);
    } else {
      assertParents(candidate);
      assertIdentity(candidate, entry);
      storage.unlinkSync(candidate);
    }
  };
  const entry = storage.lstatSync(path, { bigint: true });
  try {
    remove(path, entry);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Tree removal entry disappeared during deletion: ${path}`, { cause: error });
    throw error;
  }
}
