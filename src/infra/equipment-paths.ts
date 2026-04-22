import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';
import { resolveBuildFlavor } from '../runtime/flavor.js';
import { coralRoot, getSettledBuildFlavor } from './paths.js';

export interface EquipmentPaths {
  equipmentRoot: string;
}

export const EQUIPMENT_ADDON_FILENAMES = {
  needle: 'coral-needle.node',
} as const satisfies Record<string, string>;

export interface EquipmentPathOptions {
  readonly baseDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function resolveEquipmentFlavor(opts?: EquipmentPathOptions): BuildFlavor {
  return getSettledBuildFlavor() ?? resolveBuildFlavor(opts?.env ?? process.env);
}

function equipmentRoot(opts?: EquipmentPathOptions): string {
  return equipmentPaths(resolveEquipmentFlavor(opts), opts).equipmentRoot;
}

export function equipmentPaths(flavor: BuildFlavor, opts?: EquipmentPathOptions): EquipmentPaths {
  const base = flavor === 'dev' ? 'data-dev/equipment' : 'data/equipment';
  return {
    equipmentRoot: join(coralRoot(opts?.baseDir), base),
  };
}

export function equipmentDataDir(name: string, opts?: EquipmentPathOptions): string {
  return join(equipmentRoot(opts), name);
}

export function equipmentInstallLockPath(name: string, opts?: EquipmentPathOptions): string {
  return join(equipmentDataDir(name, opts), 'install.lock');
}

export function equipmentAddonPath(name: string, opts?: EquipmentPathOptions): string {
  return join(
    equipmentDataDir(name, opts),
    EQUIPMENT_ADDON_FILENAMES[name as keyof typeof EQUIPMENT_ADDON_FILENAMES] ?? `${name}.node`,
  );
}
