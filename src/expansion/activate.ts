import type { EquipmentView } from './equipment-contract.js';
import type { InstallResult } from './contracts.js';

export type EquipmentStatus =
  | { status: 'available'; equipment: EquipmentView[] }
  | { status: 'unavailable' };

export interface ActivationDeps {
  readEquipmentStatus(name?: string): Promise<EquipmentStatus>;
  activateExpansion(name: string): Promise<InstallResult>;
  deactivateExpansion(name: string): Promise<InstallResult>;
}

const unavailableActivation: ActivationDeps = {
  readEquipmentStatus: async () => ({ status: 'unavailable' }),
  activateExpansion: async (name) => {
    throw new Error(`Expansion activation is unavailable for ${name}.`);
  },
  deactivateExpansion: async (name) => {
    throw new Error(`Expansion deactivation is unavailable for ${name}.`);
  },
};

function resolveActivation(deps?: ActivationDeps): ActivationDeps {
  return deps ?? unavailableActivation;
}

export async function activateExpansion(name: string, deps?: ActivationDeps): Promise<InstallResult> {
  return resolveActivation(deps).activateExpansion(name);
}

export async function deactivateExpansion(name: string, deps?: ActivationDeps): Promise<InstallResult> {
  return resolveActivation(deps).deactivateExpansion(name);
}

export async function readEquipmentStatus(name?: string, deps?: ActivationDeps): Promise<EquipmentStatus> {
  return resolveActivation(deps).readEquipmentStatus(name);
}
