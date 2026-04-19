import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';
import { coralRoot } from './paths.js';

export interface EquipmentPaths {
  equipmentRoot: string;
}

export interface EquipmentPathOptions {
  readonly baseDir?: string;
}

export function equipmentPaths(flavor: BuildFlavor, opts?: EquipmentPathOptions): EquipmentPaths {
  const base = flavor === 'dev' ? 'data-dev/equipment' : 'data/equipment';
  return {
    equipmentRoot: join(coralRoot(opts?.baseDir), base),
  };
}
