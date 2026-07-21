import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { coralStateRoot } from './root.js';

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
  const base = flavor === 'dev' ? 'data-dev/store' : 'data/store';
  const dbDir = join(coralStateRoot(opts?.baseDir), base);
  const dbFile = join(dbDir, 'store.db');
  const walFile = join(dbDir, 'store.db-wal');
  const shmFile = join(dbDir, 'store.db-shm');
  return { dbDir, dbFile, walFile, shmFile };
}
