declare const __PLUGIN_ROOT__: string | undefined;

import {
  equipExpansionResultSchema,
  listExpansionResultSchema,
  unequipExpansionResultSchema,
} from '../coordinator/expansion/rpc.js';
import { installResultSchema } from './expansion/contract.js';
import type { ActivationDeps } from '../expansion/activate.js';
import { readDiscoveryRecord } from '../infra/backend-discovery.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { createRealRuntime } from '../runtime/real.js';
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

type ExpansionStatus = Awaited<ReturnType<ActivationDeps['readEquipmentStatus']>>;

function withLegacySlot<T extends { name: string; status: string }>(view: T): T & { slot: 'kb.vector' } {
  return {
    slot: 'kb.vector',
    ...view,
  };
}

export function createCliExpansionActivation(): ActivationDeps {
  return {
    async activateExpansion(name) {
      const client = await ensure(resolvePluginRoot());
      const result = equipExpansionResultSchema.parse(
        await client.request('coordinator.equipExpansion', { name }),
      );
      return installResultSchema.parse({
        ...result,
        equipment: withLegacySlot(result.equipment),
      });
    },

    async deactivateExpansion(name) {
      const client = await ensure(resolvePluginRoot());
      const result = unequipExpansionResultSchema.parse(
        await client.request('coordinator.unequipExpansion', { name }),
      );
      return installResultSchema.parse(result);
    },

    async readEquipmentStatus(name): Promise<ExpansionStatus> {
      const flavor = resolveBuildFlavor(process.env);
      const runtime = createRealRuntime(flavor);
      let record;
      try {
        record = readDiscoveryRecord({
          storage: runtime.storage,
          env: runtime.env,
          paths: runtime.paths,
        });
      } catch {
        record = null;
      }
      if (record === null) {
        return { status: 'unavailable' };
      }

      try {
        const result = listExpansionResultSchema.parse(
          await createIpcClient(record.socketPath).request('coordinator.listExpansion', {}),
        );
        const equipment = result.equipment.map(withLegacySlot);

        return {
          status: 'available',
          equipment: name === undefined ? equipment : equipment.filter((entry) => entry.name === name),
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
