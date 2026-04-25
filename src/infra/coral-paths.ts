import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import type { CoordinatorPaths } from './coordinator-paths.js';
import { coordinatorPaths } from './coordinator-paths.js';
import { coralRoot } from './coral-root.js';
import type { EquipmentPaths } from './equipment-paths.js';
import { equipmentPaths } from './equipment-paths.js';
import type { StorePaths } from './store-paths.js';
import { storePaths } from './store-paths.js';

export { coralRoot } from './coral-root.js';

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

/**
 * Mirrors `kb/paths.ts:kbRoot` — the configured KB vault may be overridden
 * via CORAL_KB_PATH at the leaf level. Duplicated here (rather than imported
 * from kb/) to keep infra/ free of upward dependencies on kb/.
 */
function corpusKbRoot(flavor: BuildFlavor, baseDir: string | undefined): string {
  if (baseDir !== undefined) {
    return join(coralRoot(baseDir), flavor === 'dev' ? 'kb-dev' : 'kb');
  }
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(coralRoot(), flavor === 'dev' ? 'kb-dev' : 'kb');
}

export function corpusPaths(flavor: BuildFlavor, opts?: CorpusPathOptions): CorpusPaths {
  const kbRootDir = corpusKbRoot(flavor, opts?.baseDir);
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

export function composeCoralPaths(flavor: BuildFlavor): CoralPaths {
  return Object.freeze({
    store: storePaths(flavor),
    corpus: corpusPaths(flavor),
    coordinator: coordinatorPaths(flavor),
    exports: exportsPaths(flavor),
    equipment: equipmentPaths(flavor),
  }) as CoralPaths;
}
