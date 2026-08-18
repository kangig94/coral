declare const __PLUGIN_ROOT__: string | undefined;

import type { EngineManifest, InstallOnlyManifest, LocalExpansionInstallState } from '../../expansion/contract.js';
import { readDiscoveryRecordDisposition } from '../../infra/backend-discovery.js';
import { assertNever, errorMessage } from '../../infra/error-format.js';
import { observeProcessLiveness } from '../../infra/node-process.js';
import type { Runtime } from '../../runtime/ports.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import { createIpcClient } from '../../transport/ipc/client.js';
import type { IpcAuthMetadata } from '../../transport/ipc/json-rpc.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../../transport/ipc/child-principal-auth.js';
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
import { INSTALL_ONLY_PACKAGES, resolveInstallOnlyManifest } from '../../expansion/install-only.js';
import { validateExpansionPackageId } from '../../expansion/package-id.js';
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

/**
 * `unavailable` is an observed absence — no coordinator recorded itself, or a recorded coordinator's pid was
 * observed decisively gone. `unreachable` is a decoded record whose pid was not observed absent, but this
 * build could not reach the coordinator it names — alive, or a probe this process could not run. `unreadable`
 * is this build failing to read or decode the evidence itself, which says nothing about whether a coordinator
 * is serving or what it holds.
 *
 * The three-way split exists because collapsing any two produced a claim about someone else's data from
 * evidence that did not support it. Collapsing `unreadable` into `unavailable` is the regression this file
 * already guards against: `readDiscoveryRecord` returns `null` for a `coordinator.json` that is truncated or
 * written in a shape this build rejects, that reached `unavailable`, and `info` then answered "no such
 * expansion" for an expansion the daemon may well be holding. Collapsing `unreachable` into `unreadable` is
 * the same mistake one failure mode later: `removeBackendInfoIfOwner` only runs on a clean shutdown, so a
 * crash/SIGKILL/OOM leaves a decoded record behind, and a record that decoded is a coordinator saying it
 * claimed this socket at some point — reporting "the record could not be read" for it is false, and it sent an
 * operator to `backend status`'s `undecodable_record` remedy for a condition that command answers differently.
 */
type ExpansionStatus =
  | { status: 'available'; expansions: Array<ExpansionView & { slot?: string }> }
  | { status: 'unavailable' }
  | { status: 'unreachable'; detail: string; path: string; pid: number }
  | { status: 'unreadable'; detail: string; path: string };

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

function localCatalogStatus(entry: EngineManifest, local: LocalExpansionInstallState): CatalogEntry['status'] {
  if (!requiresLocalInstall(entry)) {
    return 'inactive';
  }

  if (local.installLocked) {
    return 'installing';
  }

  return local.installed ? 'inactive' : 'not_equipped';
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

/**
 * Refuse to render a catalog from a daemon view we could not read or reach; return normally for every other
 * disposition, including `unavailable`.
 *
 * Every rendered status is a claim about the daemon: `not_equipped` and `inactive` say it does not hold this
 * expansion, and `unavailable` says none was found — which `clients/skills/equip/SKILL.md` pairs with "run
 * `/equip <name>` to repair or reactivate". So there is no value in the enum that means "we did not check",
 * and borrowing `unavailable` for either "the record was corrupt" or "the record decoded but nothing answered"
 * sent an agent to re-equip a whole, possibly-healthy catalog over evidence that proved neither. The refusal
 * lives here, once, because `list` and `info` both render from the same view and an earlier fix caught only
 * one of the three call sites that do.
 *
 * `unavailable` as a *disposition* still renders: no coordinator recorded itself, or a recorded coordinator's
 * pid was observed decisively gone, is an answer — nothing is equipped, and `localCatalogStatus` derives the
 * rest from local files. `unreadable` and `unreachable` get their own documented codes rather than a shared
 * one — both are codes this run could not observe an answer for, so both sit in
 * `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES` — and each remediation names the discovery record path itself
 * instead of deferring to `backend status`.
 *
 * A `switch` with `assertNever` rather than sequential `if`s: this is a `void` function whose two throwing
 * cases used to be the only visible control flow, so a third refusal variant would have compiled straight
 * into "fall through and render `unavailable`'s shape" — the exact false claim this function exists to
 * prevent. A future non-exhaustive addition to `ExpansionStatus` now fails to compile here instead.
 */
function assertDaemonViewObserved(passive: ExpansionStatus, subject: string): void {
  switch (passive.status) {
    case 'unreadable':
      // A documented setup error rather than a bare `Error`. `encodeInstallError` maps anything else to
      // `unknown_error`, whose remediation is "retry once, then report it" — advice that is wrong here in the
      // specific way §11 warns about: the retry reads the same unreadable file and reaches the same refusal, so
      // the hold names no exit. The sentence naming the real exit was already written; it was landing in
      // `userMessage` while the `remediation` field contradicted it.
      throw documentedCoralSetupError({
        code: 'coordinator_record_unreadable',
        subject,
        detail: passive.detail,
        path: passive.path,
      });
    case 'unreachable':
      // The record decoded — a coordinator claimed this socket at some point — and its pid was not observed
      // absent, so this is not the same claim as `unreadable` and must not share its code or its remedy.
      throw documentedCoralSetupError({
        code: 'coordinator_unreachable',
        subject,
        detail: passive.detail,
        path: passive.path,
        pid: String(passive.pid),
      });
    case 'available':
    case 'unavailable':
      return;
    default:
      assertNever(passive);
  }
}

function toCatalogEntry(
  entry: EngineManifest,
  runtime: Runtime,
  passive: (ExpansionView & { slot?: string }) | null,
): CatalogEntry {
  const local = inspectExpansionInstallState(runtime, entry.id);
  const provides = passive?.provides ?? entry.provides;
  const status = passive?.status ?? localCatalogStatus(entry, local);
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

function toInstallOnlyCatalogEntry(manifest: InstallOnlyManifest, runtime: Runtime): CatalogEntry {
  const local = inspectExpansionInstallState(runtime, manifest.id);
  const confirmDownload = manifest.onboarding?.find((step) => step.kind === 'confirm-download')?.message;
  const status: CatalogEntry['status'] = local.installLocked
    ? 'installing'
    : local.installed
      ? 'installed'
      : 'not_installed';
  return catalogEntrySchema.parse({
    id: manifest.id,
    name: manifest.id,
    description: manifest.description,
    activation: 'none',
    status,
    version: manifest.version,
    ...(local.installed && typeof local.addonPath === 'string' ? { command: local.addonPath } : {}),
    ...(typeof local.targetDir === 'string' ? { targetDir: local.targetDir } : {}),
    ...(typeof local.method === 'string' ? { method: local.method } : {}),
    ...(confirmDownload === undefined ? {} : { confirmDownload }),
  });
}

function toRetiredResidueCatalogEntry(view: ExpansionView): CatalogEntry {
  const packageId = validateExpansionPackageId(view.name);
  if (!packageId.ok) {
    return catalogEntrySchema.parse({
      id: view.name,
      name: view.name,
      tier: 'installed',
      description: 'Retired expansion artifacts requiring manual repair',
      activation: 'remove-catalog',
      status: 'installed-not-active',
      version: view.version ?? 'unknown',
      lastError:
        'This retired expansion id is unsafe or reserved, so Coral cannot provide an executable cleanup command. Preserve Coral state and report this entry for repair; do not construct or run a cleanup command.',
    });
  }

  const cleanupCommand = `coral-cli expansion remove-catalog ${view.name}`;
  return catalogEntrySchema.parse({
    id: view.name,
    name: view.name,
    tier: 'installed',
    description: 'Retired expansion artifacts awaiting operator cleanup',
    activation: 'remove-catalog',
    status: 'installed-not-active',
    version: view.version ?? 'unknown',
    cleanupCommand,
    lastError: view.lastError ?? `Retired expansion artifacts remain. Run '${cleanupCommand}' to remove them.`,
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
  const ipcAuth = childPrincipalAuthFromEnv();
  const ipcAuthOptions = childPrincipalAuthOptions(ipcAuth);
  const lowLevel = {
    async activateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const runtime = resolveRuntime();
      const catalog = readExpansionCatalog(runtime);
      const result = equipExpansionResultSchema.parse(
        await client.request('coordinator.equipExpansion', { name }, ipcAuthOptions),
      );
      return installResultSchema.parse({
        ...result,
        expansion: withManifestSlot(catalog, result.expansion),
      });
    },

    async deactivateExpansion(name: string) {
      const client = await ensure(resolvePluginRoot());
      const result = unequipExpansionResultSchema.parse(
        await client.request('coordinator.unequipExpansion', { name }, ipcAuthOptions),
      );
      return installResultSchema.parse(result);
    },

    async removeExpansionCatalog(name: string) {
      const client = await ensure(resolvePluginRoot());
      return removeExpansionCatalogResultSchema.parse(
        await client.request('coordinator.removeExpansionCatalog', { name }, ipcAuthOptions),
      );
    },

    async readExpansionStatus(name?: string): Promise<ExpansionStatus> {
      const runtime = resolveRuntime();
      const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
      // Computed unconditionally: the discovery record lives at a fixed location regardless of whether it
      // could be read, decoded, or reached, so every refusal below can name it directly instead of sending an
      // operator to a separate command to learn it.
      const recordPath = runtime.paths.coral.coordinator.infoFile;

      let read;
      try {
        read = readDiscoveryRecordDisposition(discoveryRuntime);
      } catch (error: unknown) {
        // The read itself failing (`EACCES`, `EIO`) is not an absent coordinator either. This used to be a
        // blanket `catch` to `null`, which is also why `backend-discovery.ts` could claim that letting these
        // throw was safe because every CLI path renders them — this path swallowed them.
        return { status: 'unreadable', detail: errorMessage(error), path: recordPath };
      }
      if (read.kind === 'undecodable') {
        return { status: 'unreadable', detail: read.reason, path: recordPath };
      }
      if (read.kind === 'missing') {
        return { status: 'unavailable' };
      }
      const record = read.record;

      try {
        const bootAuth: IpcAuthMetadata = { kind: 'boot', token: record.bootToken };
        const result = listExpansionResultSchema.parse(
          await createIpcClient(record.socketPath, runtime.time, ipcAuth === undefined ? bootAuth : undefined).request(
            'coordinator.listExpansion',
            {},
            ipcAuthOptions,
          ),
        );
        const catalog = readExpansionCatalog(runtime);
        const expansions = result.expansions.map((entry) => withManifestSlot(catalog, entry));

        return {
          status: 'available',
          expansions: name === undefined ? expansions : expansions.filter((entry) => entry.name === name),
        };
      } catch (error: unknown) {
        if (isIpcConnectFailed(error)) {
          // Reached only with a decoded record in hand, which is a coordinator saying it claimed this socket
          // at some point — `removeBackendInfoIfOwner` only runs on a clean shutdown, so a crash/SIGKILL/OOM
          // leaves it behind. `observeProcessLiveness` is the one further question this evidence supports: an
          // observed-absent pid is the same real absence `unavailable` already renders for a missing record,
          // so it renders the same way here. Alive or unknown is not an absence — reporting it as one would be
          // the false absence the `unreadable` variant above exists to prevent, one failure mode later — so it
          // gets its own disposition instead: the record was read fine, it named a live-or-unproven
          // coordinator, and this build could not reach it.
          return observeProcessLiveness(record.pid) === 'absent'
            ? { status: 'unavailable' }
            : { status: 'unreachable', detail: 'ipc_connect_failed', path: recordPath, pid: record.pid };
        }
        throw error;
      }
    },

    async readBinding(binding: string): Promise<ReadBindingResult> {
      const client = await ensure(resolvePluginRoot());
      return readBindingResultSchema.parse(
        await client.request('coordinator.readBinding', { binding }, ipcAuthOptions),
      );
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
        assertDaemonViewObserved(passive, 'the expansion catalog');
        const expansionByName =
          passive.status === 'available' ? new Map(passive.expansions.map((entry) => [entry.name, entry])) : new Map();
        const currentIds = new Set([
          ...catalog.map((entry) => entry.id),
          ...INSTALL_ONLY_PACKAGES.map((entry) => entry.id),
        ]);
        const retiredResidue =
          passive.status === 'available'
            ? passive.expansions
                .filter((entry) => !currentIds.has(entry.name))
                .map((entry) => toRetiredResidueCatalogEntry(entry))
            : [];

        return catalogResultSchema.parse({
          status: 'catalog',
          packages: [
            ...catalog.map((entry) => toCatalogEntry(entry, runtime, expansionByName.get(entry.id) ?? null)),
            ...INSTALL_ONLY_PACKAGES.map((manifest) => toInstallOnlyCatalogEntry(manifest, runtime)),
            ...retiredResidue,
          ],
        });
      } catch (error: unknown) {
        return encodeInstallError(error);
      }
    },

    async info(name: string): Promise<InstallResponse> {
      try {
        const runtime = resolveRuntime();
        const installOnly = resolveInstallOnlyManifest(name);
        if (installOnly) {
          return infoResultSchema.parse({ status: 'info', package: toInstallOnlyCatalogEntry(installOnly, runtime) });
        }

        const catalog = readExpansionCatalog(runtime);
        const entry = resolveCatalogManifest(catalog, name);
        if (!entry) {
          const passive = await lowLevel.readExpansionStatus(name);
          assertDaemonViewObserved(passive, `"${name}"`);
          const retired =
            passive.status === 'available' ? passive.expansions.find((view) => view.name === name) : undefined;
          if (retired !== undefined) {
            return infoResultSchema.parse({
              status: 'info',
              package: toRetiredResidueCatalogEntry(retired),
            });
          }
          return unknownExpansionResponse(name);
        }

        const passive = await lowLevel.readExpansionStatus(name);
        assertDaemonViewObserved(passive, `"${name}"`);
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

        if (resolveInstallOnlyManifest(name)) {
          await runExpansionOnboarding(name, createNonInteractiveOnboardingContext(lowLevel, catalog));
          return await installExpansion(name, { runtime });
        }

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

        if (resolveInstallOnlyManifest(name)) {
          return await uninstallExpansion(name, { runtime });
        }

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

        if (resolveInstallOnlyManifest(name)) {
          return await installExpansion(name, { runtime, update: true });
        }

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
