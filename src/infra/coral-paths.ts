// Canonical CoralPaths composer. The retired `src/infra/paths.ts` magnet
// must not return — see tests/invariants/architecture-boundary.test.ts and
// .claude/rules/design-philosophy.md Principle #7 (No Ambiguity).

import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import type { CoordinatorPaths } from './coordinator-paths.js';
import { coordinatorPaths } from './coordinator-paths.js';
import { coralRoot, kbVaultRoot } from './coral-root.js';
import type { EquipmentPaths } from './equipment-paths.js';
import { equipmentPaths } from './equipment-paths.js';
import type { StorePaths } from './store-paths.js';
import { storePaths } from './store-paths.js';

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
  readonly equipment: EquipmentPaths;
};

export interface CorpusPathOptions {
  readonly baseDir?: string;
}

export function corpusPaths(flavor: BuildFlavor, opts?: CorpusPathOptions): CorpusPaths {
  const kbRootDir = kbVaultRoot(flavor, opts?.baseDir);
  return {
    kbRoot: kbRootDir,
    notesDir: join(kbRootDir, 'notes'),
    sourcesDir: join(kbRootDir, 'sources'),
    principlesDir: join(kbRootDir, 'principles'),
    communitiesDir: join(kbRootDir, 'communities'),
  };
}

export interface ExportsPathOptions {
  readonly baseDir?: string;
}

export function exportsPaths(flavor: BuildFlavor, opts?: ExportsPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralRoot(opts?.baseDir), base, 'jobs'),
  };
}

export interface ComposeCoralPathOptions {
  readonly baseDir?: string;
}

export function composeCoralPaths(flavor: BuildFlavor, opts?: ComposeCoralPathOptions): CoralPaths {
  const familyOpts = opts?.baseDir === undefined ? undefined : { baseDir: opts.baseDir };
  return Object.freeze({
    store: storePaths(flavor, familyOpts),
    corpus: corpusPaths(flavor, familyOpts),
    coordinator: coordinatorPaths(flavor, undefined, familyOpts),
    exports: exportsPaths(flavor, familyOpts),
    equipment: equipmentPaths(flavor, familyOpts),
  }) as CoralPaths;
}
