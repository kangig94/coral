declare const __PLUGIN_ROOT__: string | undefined;

import {
  listEquipmentResultSchema,
  registerEquipmentResultSchema,
  unregisterResultSchema,
} from '../expansion/equipment-contract.js';
import { installResultSchema } from '../expansion/contracts.js';
import type { ActivationDeps, EquipmentStatus } from '../expansion/activate.js';
import { readPassiveDiscovery } from '../coordinator/discovery-api.js';
import { getSettledBuildFlavor } from '../infra/paths.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { createIpcClient } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';

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

export function createCliExpansionActivation(): ActivationDeps {
  return {
    async activateExpansion(name) {
      const client = await ensure(resolvePluginRoot());
      const result = registerEquipmentResultSchema.parse(
        await client.request('coordinator.registerEquipment', { name }),
      );
      return installResultSchema.parse(result);
    },

    async deactivateExpansion(name) {
      const client = await ensure(resolvePluginRoot());
      const result = unregisterResultSchema.parse(
        await client.request('coordinator.unregisterEquipment', { name }),
      );
      return installResultSchema.parse(result);
    },

    async readEquipmentStatus(name): Promise<EquipmentStatus> {
      const flavor = getSettledBuildFlavor() ?? resolveBuildFlavor(process.env);
      const record = readPassiveDiscovery(flavor);
      if (record === null) {
        return { status: 'unavailable' };
      }

      try {
        const result = listEquipmentResultSchema.parse(
          await createIpcClient(record.socketPath).request('coordinator.listEquipment', {}),
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
    },
  };
}
