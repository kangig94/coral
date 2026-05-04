declare const __PLUGIN_ROOT__: string | undefined;

import type { EngineManifest } from '../../expansion/contract.js';
import { readDiscoveryRecord } from '../../infra/backend-discovery.js';
import type { Runtime } from '../../runtime/ports.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import { createIpcClient } from '../../transport/ipc/client.js';
import { ensure } from '../../transport/ipc/ensure.js';
import {
  equipExpansionResultSchema,
  listExpansionResultSchema,
  type ExpansionView,
  infoResultSchema,
  catalogEntrySchema,
  catalogResultSchema,
  installResultSchema,
  readBindingResultSchema,
  removeExpansionCatalogResultSchema,
  unequipExpansionResultSchema,
  type CatalogEntry,
  type InstallResponse,
  type InstallResult,
  type ReadBindingResult,
  type RemoveExpansionCatalogResult,
} from '../../expansion/rpc-contract.js';
import { encodeInstallError } from './contract.js';
import { readExpansionCatalog, resolveCatalogManifest } from './catalog.js';
import { inspectExpansionInstallState, installExpansion, resolveRuntime, uninstallExpansion } from './install.js';
import { runExpansionOnboarding, type OnboardingContext } from './onboarding.js';

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
  | { status: 'available'; expansions: Array<ExpansionView & { slot?: string }> }
  | { status: 'unavailable' };

export interface CliExpansionActivation {
  list(): Promise<InstallResponse>;
  info(name: string): Promise<InstallResponse>;
  equip(name: string): Promise<InstallResponse>;
  unequip(name: string): Promise<InstallResponse>;
  update(name: string): Promise<InstallResponse>;
  activateExpansion(name: string): Promise<InstallResult>;
  deactivateExpansion(name: string): Promise<InstallResult>;
  removeExpansionCatalog(name: string): Promise<RemoveExpansionCatalogResult>;
  removeCatalog(name: string): Promise<InstallResponse>;
  readExpansionStatus(name?: string): Promise<ExpansionStatus>;
  readBinding(binding: string): Promise<ReadBindingResult>;
}

function requiresLocalInstall(entry: EngineManifest): boolean {
  return entry.tier === 'installed' && entry.installer !== undefined;
}

function resolveManifestSlot(catalog: readonly EngineManifest[], name: string): string | undefined {
  return resolveCatalogManifest(catalog, name)?.fills?.[0];
}

function withManifestSlot<T extends { name: string; status: string }>(
  catalog: readonly EngineManifest[],
  view: T,
): T & { slot?: string } {
  const slot = resolveManifestSlot(catalog, view.name);
  return {
    ...view,
    ...(slot === undefined ? {} : { slot }),
  };
}

function unknownExpansionResponse(name: string) {
  return encodeInstallError(documentedCoralSetupError('unknown_expansion', { name }));
}

function toCatalogEntry(
  entry: EngineManifest,
  runtime: Runtime,
  passive: (ExpansionView & { slot?: string }) | null,
): CatalogEntry {
  const local = inspectExpansionInstallState(runtime, entry.id);
  const provides = passive?.provides ?? entry.provides;
  const status =
    passive?.status ??
    (requiresLocalInstall(entry)
      ? local.installLocked
        ? 'installing'
        : local.installed
          ? 'inactive'
          : 'not_equipped'
      : 'inactive');
  return catalogEntrySchema.parse({
    id: entry.id,
    name: entry.id,
    tier: entry.tier,
    description: entry.description,
    activation: 'equip',
    status,
    ...(requiresLocalInstall(entry) && typeof local.addonPath === 'string' ? { addonPath: local.addonPath } : {}),
    version: local.version ?? entry.version,
    ...(passive?.lastError === undefined ? {} : { lastError: passive.lastError }),
    ...(provides === undefined ? {} : { provides }),
    ...(passive?.capabilityStatus === undefined ? {} : { capabilityStatus: passive.capabilityStatus }),
  });
}

function createNonInteractiveOnboardingContext(
  lowLevel: Pick<CliExpansionActivation, 'readBinding'>,
  catalog: readonly EngineManifest[],
): OnboardingContext {
  const context: OnboardingContext = {
    interactive: false,
    catalog,
    readBinding: (binding) => lowLevel.readBinding(binding),
    prompt: {
      choose: async () => null,
      confirm: async () => true,
    },
    runOnboarding: async (id) => {
      await runExpansionOnboarding(id, context);
    },
    equip: async () => {
      throw documentedCoralSetupError('binding_required', {
        binding: 'unknown',
        requiredBy: 'this expansion',
        candidates: [],
      });
    },
  };

  return context;
}

export function createCliExpansionActivation(): CliExpansionActivation {
  const lowLevel = {
    async activateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const runtime = resolveRuntime();
      const catalog = readExpansionCatalog(runtime);
      const result = equipExpansionResultSchema.parse(await client.request('coordinator.equipExpansion', { name }));
      return installResultSchema.parse({
        ...result,
        expansion: withManifestSlot(catalog, result.expansion),
      });
    },

    async deactivateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const result = unequipExpansionResultSchema.parse(await client.request('coordinator.unequipExpansion', { name }));
      return installResultSchema.parse(result);
    },

    async removeExpansionCatalog(name: string) {
      const client = await ensure(resolvePluginRoot());
      return removeExpansionCatalogResultSchema.parse(
        await client.request('coordinator.removeExpansionCatalog', { name }),
      );
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
        const catalog = readExpansionCatalog(runtime);
        const expansions = result.expansions.map((entry) => withManifestSlot(catalog, entry));

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

    async readBinding(binding: string): Promise<ReadBindingResult> {
      const client = await ensure(resolvePluginRoot());
      return readBindingResultSchema.parse(await client.request('coordinator.readBinding', { binding }));
    },
  } satisfies Pick<
    CliExpansionActivation,
    'activateExpansion' | 'deactivateExpansion' | 'removeExpansionCatalog' | 'readExpansionStatus' | 'readBinding'
  >;

  return {
    ...lowLevel,
    async list(): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const catalog = readExpansionCatalog(runtime);
        const passive = await lowLevel.readExpansionStatus();
        const expansionByName =
          passive.status === 'available' ? new Map(passive.expansions.map((entry) => [entry.name, entry])) : new Map();

        return catalogResultSchema.parse({
          status: 'catalog',
          packages: catalog.map((entry) => toCatalogEntry(entry, runtime, expansionByName.get(entry.id) ?? null)),
        });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async info(name: string): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const catalog = readExpansionCatalog(runtime);
        const entry = resolveCatalogManifest(catalog, name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        const passive = await lowLevel.readExpansionStatus(name);
        return infoResultSchema.parse({
          status: 'info',
          package: toCatalogEntry(
            entry,
            runtime,
            passive.status === 'available' ? (passive.expansions[0] ?? null) : null,
          ),
        });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async equip(name: string): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const catalog = readExpansionCatalog(runtime);
        const entry = resolveCatalogManifest(catalog, name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        await runExpansionOnboarding(name, createNonInteractiveOnboardingContext(lowLevel, catalog));

        if (requiresLocalInstall(entry)) {
          const installResult = await installExpansion(name, { runtime });
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
        const runtime = resolveRuntime();
        const catalog = readExpansionCatalog(runtime);
        const entry = resolveCatalogManifest(catalog, name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        const removal = await lowLevel.removeExpansionCatalog(name);
        if (removal.status === 'blocked') {
          return encodeInstallError(
            documentedCoralSetupError({
              code: 'capability_catalog_remove_blocked',
              target: removal.target,
              capabilities: removal.capabilities,
              dependents: removal.dependents,
            }),
          );
        }
        if (removal.status === 'unknown') {
          return unknownExpansionResponse(name);
        }

        if (!requiresLocalInstall(entry)) {
          if (removal.status === 'immutable') {
            return encodeInstallError(documentedCoralSetupError('expansion_bundled_immutable', { name }));
          }
          return installResultSchema.parse({ status: 'uninstalled' });
        }

        return await uninstallExpansion(name, { runtime });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async removeCatalog(name: string): Promise<InstallResponse> {
      try {
        const removal = await lowLevel.removeExpansionCatalog(name);
        if (removal.status === 'removed') {
          return installResultSchema.parse({ status: 'uninstalled' });
        }
        if (removal.status === 'immutable') {
          return encodeInstallError(documentedCoralSetupError('expansion_bundled_immutable', { name }));
        }
        if (removal.status === 'unknown') {
          return unknownExpansionResponse(name);
        }
        return encodeInstallError(
          documentedCoralSetupError({
            code: 'capability_catalog_remove_blocked',
            target: removal.target,
            capabilities: removal.capabilities,
            dependents: removal.dependents,
          }),
        );
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async update(name: string): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const catalog = readExpansionCatalog(runtime);
        const entry = resolveCatalogManifest(catalog, name);
        if (!entry) {
          return unknownExpansionResponse(name);
        }

        if (requiresLocalInstall(entry)) {
          const installResult = await installExpansion(name, { runtime, update: true });
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
