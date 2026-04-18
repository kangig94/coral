import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';

export interface StorePaths {
  dbDir: string;
  dbFile: string;
  walFile: string;
}

export function storePaths(flavor: BuildFlavor): StorePaths {
  const base = flavor === 'dev' ? 'data-dev/store' : 'data/store';
  const dbDir = join(homedir(), '.coral', base);
  const dbFile = join(dbDir, 'store.db');
  const walFile = join(dbDir, 'store.db-wal');
  return { dbDir, dbFile, walFile };
}
