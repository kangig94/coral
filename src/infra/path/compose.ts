// Canonical CoralPaths composer. Public surface of the `infra/path/` subdir;
// sibling files (root/store/coordinator/expansion) stay subdir-internal so the
// runtime port (`runtime.paths.coral`) is the single access path. The retired
// `src/infra/paths.ts` magnet must not return — see
// tests/invariants/architecture-boundary.test.ts.

import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import type { CoordinatorPaths } from './coordinator.js';
import { coordinatorPaths } from './coordinator.js';
import { coralRoot, kbVaultRoot } from './root.js';
import type { ExpansionPaths } from './expansion.js';
import { expansionPaths } from './expansion.js';
import type { StorePaths } from './store.js';
import { storePaths } from './store.js';

export interface CorpusPaths {
  kbRoot: string;
  notesDir: string;
  sourcesDir: string;
  principlesDir: string;
  communitiesDir: string;
}

export interface ExportsPaths {
  jobsRoot: string;
}

export type CoralPaths = {
  readonly store: StorePaths;
  readonly corpus: CorpusPaths;
  readonly coordinator: CoordinatorPaths;
  readonly exports: ExportsPaths;
  readonly expansion: ExpansionPaths;
};

// Re-export per-family types so external callers (transport, expansion,
// test fixtures) see a single public surface for path-shape vocabulary.
// Runtime path-construction functions stay subdir-internal.
export type { CoordinatorPaths } from './coordinator.js';
export type { ExpansionPaths } from './expansion.js';
export type { StorePaths } from './store.js';

export interface FamilyPathOptions {
  readonly baseDir?: string;
}

export interface CorpusPathOptions extends FamilyPathOptions {
  /** Resolved CORAL_KB_PATH value from caller's env port (vault override). */
  readonly customKbRoot?: string;
}

// `corpusPaths` and `exportsPaths` live inside the composer file rather than
// in their own siblings: corpus piggybacks on `kbVaultRoot` (already in
// root.ts) and exports has a single field. Splitting either into its own
// file would be premature. They stay exported for path-layout tests that
// assert each family in isolation.
export function corpusPaths(flavor: BuildFlavor, opts?: CorpusPathOptions): CorpusPaths {
  const kbRootDir = kbVaultRoot(flavor, {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(opts?.customKbRoot === undefined ? {} : { customRoot: opts.customKbRoot }),
  });
  return {
    kbRoot: kbRootDir,
    notesDir: join(kbRootDir, 'notes'),
    sourcesDir: join(kbRootDir, 'sources'),
    principlesDir: join(kbRootDir, 'principles'),
    communitiesDir: join(kbRootDir, 'communities'),
  };
}

export function exportsPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralRoot(opts?.baseDir), base, 'jobs'),
  };
}

export interface ComposeCoralPathOptions {
  readonly baseDir?: string;
  /** Resolved CORAL_KB_PATH value from caller's env port. */
  readonly customKbRoot?: string;
}

export function composeCoralPaths(flavor: BuildFlavor, opts?: ComposeCoralPathOptions): CoralPaths {
  const familyOpts = opts?.baseDir === undefined ? undefined : { baseDir: opts.baseDir };
  const corpusOpts: CorpusPathOptions = {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(opts?.customKbRoot === undefined ? {} : { customKbRoot: opts.customKbRoot }),
  };
  return {
    store: storePaths(flavor, familyOpts),
    corpus: corpusPaths(flavor, corpusOpts),
    coordinator: coordinatorPaths(flavor, undefined, familyOpts),
    exports: exportsPaths(flavor, familyOpts),
    expansion: expansionPaths(flavor, familyOpts),
  };
}
