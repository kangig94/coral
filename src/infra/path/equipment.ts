import { join } from 'node:path';
import type { BuildFlavor } from '../build-flavor.js';
import { coralRoot } from './root.js';

export const EQUIPMENT_ADDON_FILENAMES = {
  needle: 'coral-needle.node',
} as const satisfies Record<string, string>;

export interface EquipmentPaths {
  readonly equipmentRoot: string;
  dataDir(name: string): string;
  installLockPath(name: string): string;
  addonPath(name: string): string;
}

export interface EquipmentPathOptions {
  readonly baseDir?: string;
}

export function equipmentPaths(flavor: BuildFlavor, opts?: EquipmentPathOptions): EquipmentPaths {
  const base = flavor === 'dev' ? 'data-dev/equipment' : 'data/equipment';
  const equipmentRoot = join(coralRoot(opts?.baseDir), base);
  const dataDir = (name: string): string => join(equipmentRoot, name);
  return {
    equipmentRoot,
    dataDir,
    installLockPath: (name) => join(dataDir(name), 'install.lock'),
    addonPath: (name) =>
      join(
        dataDir(name),
        EQUIPMENT_ADDON_FILENAMES[name as keyof typeof EQUIPMENT_ADDON_FILENAMES] ?? `${name}.node`,
      ),
  };
}
