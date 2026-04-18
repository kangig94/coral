import type { BuildFlavor } from '../runtime/flavor.js';
import type { CoralPaths } from '../infra/coral-paths.js';
import { storePaths } from '../store/paths.js';
import { corpusPaths } from '../kb/corpus/paths.js';
import { coordinatorPaths } from './info.js';
import { exportsPaths } from '../jobs/exports/paths.js';
import { equipmentPaths } from '../infra/equipment-paths.js';

export type { CoralPaths } from '../infra/coral-paths.js';

export function composeCoralPaths(flavor: BuildFlavor): CoralPaths {
  return Object.freeze({
    store: storePaths(flavor),
    corpus: corpusPaths(flavor),
    coordinator: coordinatorPaths(flavor),
    exports: exportsPaths(flavor),
    equipment: equipmentPaths(flavor),
  }) as CoralPaths;
}
