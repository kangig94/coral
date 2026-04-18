import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';

export interface EquipmentPaths {
  equipmentRoot: string;
}

export function equipmentPaths(flavor: BuildFlavor): EquipmentPaths {
  const base = flavor === 'dev' ? 'data-dev/equipment' : 'data/equipment';
  return {
    equipmentRoot: join(homedir(), '.coral', base),
  };
}
