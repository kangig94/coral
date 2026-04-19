import type { StorePaths } from '../store/paths.js';
import type { CorpusPaths } from '../kb/corpus/paths.js';
import type { CoordinatorPaths } from '../coordinator/paths.js';
import type { ExportsPaths } from '../jobs/exports/paths.js';
import type { EquipmentPaths } from './equipment-paths.js';

export type CoralPaths = {
  readonly store: StorePaths;
  readonly corpus: CorpusPaths;
  readonly coordinator: CoordinatorPaths;
  readonly exports: ExportsPaths;
  readonly equipment: EquipmentPaths;
};
