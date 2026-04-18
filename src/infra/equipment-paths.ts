import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';

export interface EquipmentPaths {
  equipmentRoot: string;
}

export interface EquipmentPathOptions {
  readonly baseDir?: string;
}

function coralRoot(opts?: EquipmentPathOptions): string {
  return opts?.baseDir ?? join(homedir(), '.coral');
}

export function equipmentPaths(flavor: BuildFlavor, opts?: EquipmentPathOptions): EquipmentPaths {
  const base = flavor === 'dev' ? 'data-dev/equipment' : 'data/equipment';
  return {
    equipmentRoot: join(coralRoot(opts), base),
  };
}
