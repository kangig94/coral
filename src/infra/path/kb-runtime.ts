import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { generationStateRoot } from './root.js';

// Sibling of `data/store` (store.ts) and `data/engines` (engine.ts) under the same state tree. This is the
// KB *runtime* tree — indexes and source-import staging — and is distinct from `corpus.kbRoot`, which is the
// Markdown vault the Corpus owns. It is a composed family rather than a bare `kbRuntimeDir(flavor)` helper
// so it threads `baseDir` like its two siblings do.
export interface KbRuntimePaths {
  /** Root of the KB runtime tree (`<generationRoot>/data/kb`, or `data-dev/kb` under the dev flavor). */
  readonly root: string;
}

export interface KbRuntimePathOptions {
  readonly baseDir?: string;
}

export function kbRuntimePaths(flavor: BuildFlavor, opts?: KbRuntimePathOptions): KbRuntimePaths {
  return { root: join(generationStateRoot(flavor, opts), 'kb') };
}
