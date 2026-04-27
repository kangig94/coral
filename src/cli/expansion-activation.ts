declare const __PLUGIN_ROOT__: string | undefined;

import type { BundledExpansion } from '../expansion/contract.js';
import { BUNDLED_EXPANSIONS } from '../expansion/bundled.js';
import { readDiscoveryRecord } from '../infra/coordinator-discovery.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { createIpcClient } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';
import {
  equipExpansionResultSchema,
  listExpansionResultSchema,
  type ExpansionView,
  infoResultSchema,
  catalogEntrySchema,
  catalogResultSchema,
  installResultSchema,
  unequipExpansionResultSchema,
  type CatalogEntry,
  type InstallResponse,
  type InstallResult,
} from '../coordinator/expansion/rpc.js';
import { encodeInstallError } from './expansion/contract.js';
import { inspectExpansionInstallState, installExpansion, uninstallExpansion } from './expansion/install.js';

function resolvePluginRoot(): string | undefined {
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return typeof __PLUGIN_ROOT__ === 'string' && __PLUGIN_ROOT__.length > 0 ? __PLUGIN_ROOT__ : undefined;
}

function isIpcConnectFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ipc_connect_failed'
  );
}

export type ExpansionStatus =
  | { status: 'available'; expansions: Array<ExpansionView & { slot: string }> }
  | { status: 'unavailable' };

export interface CliExpansionActivation {
  list(): Promise<InstallResponse>;
  info(name: string): Promise<InstallResponse>;
  equip(name: string): Promise<InstallResponse>;
  unequip(name: string): Promise<InstallResponse>;
  update(name: string): Promise<InstallResponse>;
  activateExpansion(name: string): Promise<InstallResult>;
  deactivateExpansion(name: string): Promise<InstallResult>;
  readExpansionStatus(name?: string): Promise<ExpansionStatus>;
}

function requiresLocalInstall(entry: BundledExpansion): boolean {
  return entry.metadata.repo !== undefined;
}

function resolveManifestSlot(name: string): string {
  return resolveBundledExpansion(name)?.metadata.slot ?? 'kb.vector';
}

function withManifestSlot<T extends { name: string; status: string }>(view: T): T & { slot: string } {
  return {
    slot: resolveManifestSlot(view.name),
    ...view,
  };
}

function resolveRuntime(): Runtime {
  return createRealRuntime(resolveBuildFlavor(process.env));
}

function resolveBundledExpansion(name: string): BundledExpansion | null {
  return BUNDLED_EXPANSIONS.find((entry) => entry.id === name) ?? null;
}

function unknownExpansionResponse(name: string) {
  return encodeInstallError(documentedCoralSetupError('unknown_expansion', { name }));
}

function toCatalogEntry(
  entry: BundledExpansion,
  runtime: Runtime,
  passive: (ExpansionView & { slot: string }) | null,
): CatalogEntry {
  const local = inspectExpansionInstallState(runtime, entry.id);
  const status =
    passive?.status
    ?? (requiresLocalInstall(entry)
      ? (local.installLocked ? 'installing' : local.installed ? 'inactive' : 'not_equipped')
      : 'inactive');
  return catalogEntrySchema.parse({
    id: entry.id,
    name: entry.id,
    description: entry.metadata.description,
    activation: 'equip',
    status,
    ...(requiresLocalInstall(entry) ? { addonPath: local.addonPath } : {}),
    version: local.version ?? entry.version,
    ...(passive?.lastError === undefined ? {} : { lastError: passive.lastError }),
  });
}

export function createCliExpansionActivation(): CliExpansionActivation {
  const lowLevel = {
    async activateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const result = equipExpansionResultSchema.parse(await client.request('coordinator.equipExpansion', { name }));
      return installResultSchema.parse({
        ...result,
        expansion: withManifestSlot(result.expansion),
      });
    },

    async deactivateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const result = unequipExpansionResultSchema.parse(await client.request('coordinator.unequipExpansion', { name }));
      return installResultSchema.parse(result);
    },

    async readExpansionStatus(name?: string): Promise<ExpansionStatus> {
      const runtime = resolveRuntime();
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
        const expansions = result.expansions.map(withManifestSlot);

        return {
          status: 'available',
          expansions: name === undefined ? expansions : expansions.filter((entry) => entry.name === name),
        };
      } catch (error: unknown) {
        if (isIpcConnectFailed(error)) {
          return { status: 'unavailable' };
        }
        throw error;
      }
    },
  } satisfies Pick<CliExpansionActivation, 'activateExpansion' | 'deactivateExpansion' | 'readExpansionStatus'>;

  return {
    ...lowLevel,
    async list(): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const passive = await lowLevel.readExpansionStatus();
        const expansionByName =
          passive.status === 'available' ? new Map(passive.expansions.map((entry) => [entry.name, entry])) : new Map();

        return catalogResultSchema.parse({
          status: 'catalog',
          packages: BUNDLED_EXPANSIONS.map((entry) => toCatalogEntry(entry, runtime, expansionByName.get(entry.id) ?? null)),
        });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async info(name: string): Promise<InstallResponse> {
      try {
        const entry = resolveBundledExpansion(name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        const passive = await lowLevel.readExpansionStatus(name);
        return infoResultSchema.parse({
          status: 'info',
          package: toCatalogEntry(entry, resolveRuntime(), passive.status === 'available' ? (passive.expansions[0] ?? null) : null),
        });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async equip(name: string): Promise<InstallResponse> {
      try {
        const entry = resolveBundledExpansion(name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        if (requiresLocalInstall(entry)) {
          const installResult = await installExpansion(name);
          if (installResult.status === 'error') {
            return installResult;
          }
        }

        return await lowLevel.activateExpansion(name);
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async unequip(name: string): Promise<InstallResponse> {
      try {
        const entry = resolveBundledExpansion(name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        const passive = await lowLevel.readExpansionStatus(name);
        const activeEntry = passive.status === 'available' ? passive.expansions[0] : undefined;
        if (activeEntry !== undefined) {
          await lowLevel.deactivateExpansion(name);
        }

        if (!requiresLocalInstall(entry)) {
          return installResultSchema.parse({ status: activeEntry ? 'uninstalled' : 'not_equipped' });
        }

        return await uninstallExpansion(name);
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async update(name: string): Promise<InstallResponse> {
      try {
        const entry = resolveBundledExpansion(name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        if (requiresLocalInstall(entry)) {
          const installResult = await installExpansion(name, { update: true });
          if (installResult.status === 'error' || installResult.status === 'already_up_to_date') {
            return installResult;
          }
        }

        return await lowLevel.activateExpansion(name);
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },
  };
}
