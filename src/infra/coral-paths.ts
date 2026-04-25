import type { BuildFlavor } from './build-flavor.js';
import type { StorePaths } from './store-paths.js';
import { storePaths } from './store-paths.js';
import type { CorpusPaths } from './corpus-paths.js';
import { corpusPaths } from './corpus-paths.js';
import type { CoordinatorPaths } from './coordinator-paths.js';
import { coordinatorPaths } from './coordinator-paths.js';
import type { ExportsPaths } from './exports-paths.js';
import { exportsPaths } from './exports-paths.js';
import type { EquipmentPaths } from './equipment-paths.js';
import { equipmentPaths } from './equipment-paths.js';

export type CoralPaths = {
  readonly store: StorePaths;
  readonly corpus: CorpusPaths;
  readonly coordinator: CoordinatorPaths;
  readonly exports: ExportsPaths;
  readonly equipment: EquipmentPaths;
};

export function composeCoralPaths(flavor: BuildFlavor): CoralPaths {
  return Object.freeze({
    store: storePaths(flavor),
    corpus: corpusPaths(flavor),
    coordinator: coordinatorPaths(flavor),
    exports: exportsPaths(flavor),
    equipment: equipmentPaths(flavor),
  }) as CoralPaths;
}
