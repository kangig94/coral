import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { generationStateRoot } from './root.js';

export interface StorePaths {
  dbDir: string;
  dbFile: string;
  walFile: string;
  shmFile: string;
}

export interface StorePathOptions {
  readonly baseDir?: string;
}

export function storePaths(flavor: BuildFlavor, opts?: StorePathOptions): StorePaths {
  const dbDir = join(generationStateRoot(flavor, opts), 'store');
  const dbFile = join(dbDir, 'store.db');
  const walFile = join(dbDir, 'store.db-wal');
  const shmFile = join(dbDir, 'store.db-shm');
  return { dbDir, dbFile, walFile, shmFile };
}
