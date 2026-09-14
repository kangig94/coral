import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { generationStateRoot } from './root.js';

export interface StorePaths {
  dbDir: string;
}

export interface StorePathOptions {
  readonly baseDir?: string;
}

export function storePaths(flavor: BuildFlavor, opts?: StorePathOptions): StorePaths {
  const dbDir = join(generationStateRoot(flavor, opts), 'store');
  return { dbDir };
}
