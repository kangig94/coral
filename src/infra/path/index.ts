// Canonical CoralPaths composer. Public surface of the `infra/path/` subdir;
// sibling files (root/store/coordinator/engine) stay subdir-internal so the
// runtime port (`runtime.paths.coral`) is the single access path. The retired
// `src/infra/paths.ts` magnet must not return — see
// tests/invariants/architecture-boundary.test.ts.

import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { type CoordinatorPaths, coordinatorPaths } from './coordinator.js';
import { coralStateRoot, kbVaultRoot } from './root.js';
import { type EnginePaths, enginePaths } from './engine.js';
import { type StorePaths, storePaths } from './store.js';

export interface CorpusPaths {
  kbRoot: string;
  notesDir: string;
  sourcesDir: string;
  principlesDir: string;
  communitiesDir: string;
  wikiDir: string;
}

export interface ExportsPaths {
  jobsRoot: string;
}

export interface ProjectsPaths {
  /** Root of the per-project data tree (`<coralRoot>/projects`). */
  readonly root: string;
  /** Per-project data directory for an already-resolved project source. */
  dataDir(source: string): string;
}

export type CoralPaths = {
  readonly store: StorePaths;
  readonly corpus: CorpusPaths;
  readonly coordinator: CoordinatorPaths;
  readonly exports: ExportsPaths;
  readonly engine: EnginePaths;
  readonly projects: ProjectsPaths;
};

// Re-export per-family types so external callers (transport, expansion,
// test fixtures) see a single public surface for path-shape vocabulary.
// Runtime path-construction functions stay subdir-internal.
export type { CoordinatorPaths } from './coordinator.js';
// Config-dir resolution remains public for plugin discovery and provider
// credentials. It never participates in Coral daemon path composition.
export { resolveClaudeConfigDir, resolveUserHomeDir } from './root.js';

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
    wikiDir: join(kbRootDir, 'wiki'),
  };
}

export function exportsPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralStateRoot(opts?.baseDir), base, 'jobs'),
  };
}

/** Map a project source (`owner/repo` or `local/basename`) to its directory slug. */
function sourceToSlug(source: string): string {
  return source.replace(/\//g, '-');
}

// Flavor-separated like every other family: prod writes under `projects`, dev
// under `projects-dev`, so a dev build never shares a project's memo tree with
// prod. Enforced uniformly by tests/invariants/flavor-path-separation.test.ts.
export function projectsPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): ProjectsPaths {
  const root = join(coralStateRoot(opts?.baseDir), flavor === 'dev' ? 'projects-dev' : 'projects');
  return {
    root,
    dataDir: (source) => join(root, sourceToSlug(source)),
  };
}

export interface ComposeCoralPathOptions {
  readonly baseDir?: string;
  /** Resolved CORAL_KB_PATH value from caller's env port. */
  readonly customKbRoot?: string;
}

export function composeCoralPaths(flavor: BuildFlavor, opts?: ComposeCoralPathOptions): CoralPaths {
  // Provider account selection never changes Coral-owned state paths.
  const stateOpts: FamilyPathOptions = {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
  };
  const corpusOpts: CorpusPathOptions = {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(opts?.customKbRoot === undefined ? {} : { customKbRoot: opts.customKbRoot }),
  };
  return {
    store: storePaths(flavor, stateOpts),
    corpus: corpusPaths(flavor, corpusOpts),
    coordinator: coordinatorPaths(flavor, undefined, stateOpts),
    exports: exportsPaths(flavor, stateOpts),
    engine: enginePaths(flavor, stateOpts),
    projects: projectsPaths(flavor, stateOpts),
  };
}
