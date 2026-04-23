declare const __PLUGIN_ROOT__: string | undefined;

import {
  listEquipmentResultSchema,
  registerEquipmentResultSchema,
  type EquipmentView,
  unregisterResultSchema,
} from './equipment-contract.js';
import { readPassiveDiscovery } from '../coordinator/discovery-api.js';
import { getSettledBuildFlavor } from '../infra/paths.js';
import { resolveBuildFlavor } from '../runtime/flavor.js';
import { createIpcClient } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';
import { installResultSchema, type InstallResult } from './contracts.js';

export type EquipmentStatus =
  | { status: 'available'; equipment: EquipmentView[] }
  | { status: 'unavailable' };

export interface ActivationDeps {
  readonly ensureClient?: typeof ensure;
  readonly readPassiveDiscovery?: typeof readPassiveDiscovery;
  readonly ipcClientFactory?: typeof createIpcClient;
  readonly resolveFlavor?: typeof resolveBuildFlavor;
  readonly pluginRootResolver?: () => string | undefined;
}

function resolvePluginRoot(): string | undefined {
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return typeof __PLUGIN_ROOT__ === 'string' && __PLUGIN_ROOT__.length > 0 ? __PLUGIN_ROOT__ : undefined;
}

function isIpcConnectFailed(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ipc_connect_failed'
  );
}

export async function activateExpansion(name: string, deps: ActivationDeps = {}): Promise<InstallResult> {
  const client = await (deps.ensureClient ?? ensure)((deps.pluginRootResolver ?? resolvePluginRoot)());
  const result = registerEquipmentResultSchema.parse(
    await client.request('coordinator.registerEquipment', { name }),
  );
  return installResultSchema.parse(result);
}

export async function deactivateExpansion(name: string, deps: ActivationDeps = {}): Promise<InstallResult> {
  const client = await (deps.ensureClient ?? ensure)((deps.pluginRootResolver ?? resolvePluginRoot)());
  const result = unregisterResultSchema.parse(
    await client.request('coordinator.unregisterEquipment', { name }),
  );
  return installResultSchema.parse(result);
}

export async function readEquipmentStatus(name?: string, deps: ActivationDeps = {}): Promise<EquipmentStatus> {
  const flavor = getSettledBuildFlavor() ?? (deps.resolveFlavor ?? resolveBuildFlavor)(process.env);
  const record = (deps.readPassiveDiscovery ?? readPassiveDiscovery)(flavor);
  if (record === null) {
    return { status: 'unavailable' };
  }

  try {
    const result = listEquipmentResultSchema.parse(
      await (deps.ipcClientFactory ?? createIpcClient)(record.socketPath).request('coordinator.listEquipment', {}),
    );

    return {
      status: 'available',
      equipment: name === undefined ? result.equipment : result.equipment.filter((entry) => entry.name === name),
    };
  } catch (error: unknown) {
    if (isIpcConnectFailed(error)) {
      return { status: 'unavailable' };
    }
    throw error;
  }
}
