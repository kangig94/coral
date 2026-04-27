import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import type { EquipmentView } from './equipment-contract.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { kbRuntimeDir } from '../kb/paths.js';
import { readEquipmentStatus, activateExpansion, deactivateExpansion, type ActivationDeps } from './activate.js';
import {
  catalogEntrySchema,
  catalogResultSchema,
  infoResultSchema,
  installResultSchema,
  type CatalogEntry,
  type CatalogEntryStatus,
  type InstallResponse,
  type InstallResult,
  type Onboarding,
} from './contracts.js';
import { encodeInstallError } from './errors.js';
import { getCatalogEntry, listCatalogEntries, type CatalogBinding } from './catalog.js';
import { installExpansion, uninstallExpansion } from './install.js';
import { inspectGithubBinaryInstall, type GithubBinaryConfig } from './strategies/github-binary.js';
import { createExpansionInstallContext, type ExpansionInstallContext } from './strategies/strategy.js';

const INSTALL_ONLY_STATUS_DESCRIPTIONS: Record<'installing' | 'not_installed' | 'installed', string> = {
  installing: 'Another coral-cli expansion equip is currently holding install.lock.',
  not_installed: 'Expansion is not installed locally.',
  installed: 'Expansion is installed locally and ready to use.',
};

export interface WorkflowOptions {
  readonly runtime?: Runtime;
  readonly logger?: ExpansionInstallContext['logger'];
  readonly lockTimeoutMs?: number;
  readonly activation?: ActivationDeps;
}

function createContext(runtime?: Runtime, logger?: ExpansionInstallContext['logger']): ExpansionInstallContext {
  return createExpansionInstallContext(runtime ?? createRealRuntime(resolveBuildFlavor(process.env)), logger);
}

function unknownEquipmentResponse(name: string): InstallResponse {
  return encodeInstallError(documentedCoralSetupError('unknown_equipment', { name }));
}

function readEquipmentStatusWithDeps(name: string | undefined, activation?: ActivationDeps) {
  return activation === undefined ? readEquipmentStatus(name) : readEquipmentStatus(name, activation);
}

function activateExpansionWithDeps(name: string, activation?: ActivationDeps) {
  return activation === undefined ? activateExpansion(name) : activateExpansion(name, activation);
}

function deactivateExpansionWithDeps(name: string, activation?: ActivationDeps) {
  return activation === undefined ? deactivateExpansion(name) : deactivateExpansion(name, activation);
}

function installExpansionWithOptions(name: string, opts: Parameters<typeof installExpansion>[1] | undefined) {
  return opts === undefined ? installExpansion(name) : installExpansion(name, opts);
}

function uninstallExpansionWithOptions(name: string, opts: Parameters<typeof uninstallExpansion>[1] | undefined) {
  return opts === undefined ? uninstallExpansion(name) : uninstallExpansion(name, opts);
}

function buildMutationOptions(
  ctx: ExpansionInstallContext,
  opts: WorkflowOptions,
  extra: { update?: boolean } = {},
):
  | { runtime?: Runtime; logger?: ExpansionInstallContext['logger']; lockTimeoutMs?: number; update?: boolean }
  | undefined {
  const resolved = {
    ...(opts.runtime === undefined ? {} : { runtime: ctx.runtime }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    ...(opts.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: opts.lockTimeoutMs }),
    ...(extra.update === undefined ? {} : { update: extra.update }),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function installLockExists(ctx: ExpansionInstallContext, name: string): boolean {
  try {
    ctx.runtime.storage.statSync(ctx.runtime.paths.coral.equipment.installLockPath(name));
    return true;
  } catch {
    return false;
  }
}

function equipCommand(name: string): string {
  return `coral-cli expansion equip ${name}`;
}

function equipmentStatusDescription(
  entry: Pick<CatalogEntry, 'id' | 'name'>,
  status: Exclude<CatalogEntryStatus, 'not_installed' | 'installed'>,
): string {
  switch (status) {
    case 'equipped':
      return 'Active in the coordinator.';
    case 'catching_up':
      return 'Registered and replaying the corpus.';
    case 'inactive':
      return `Installed locally but not registered. Run ${equipCommand(entry.id)} to reactivate.`;
    case 'installed-not-active':
      return `Installed, but recovery could not reactivate it. Run ${equipCommand(entry.id)} to retry.`;
    case 'unavailable':
      return `Binary missing. Run ${equipCommand(entry.id)} to reinstall.`;
    case 'disabled_pending_reinstall':
      return `Load failed. Run ${equipCommand(entry.id)} to reinstall.`;
    case 'installing':
      return 'Another coral-cli expansion equip is currently holding install.lock.';
    case 'not_equipped':
      return `${entry.name} is not installed.`;
  }
}

function hasDurableEquipmentState(ctx: ExpansionInstallContext, name: string): boolean {
  try {
    return ctx.runtime.storage
      .readdirSync(ctx.runtime.paths.coral.equipment.dataDir(name), { withFileTypes: true })
      .some((entry) => entry.name !== 'install.lock');
  } catch {
    return false;
  }
}

function resolveOnboarding(config: unknown): Onboarding | undefined {
  if (
    typeof config === 'object' &&
    config !== null &&
    'onboarding' in config &&
    typeof (config as { onboarding?: unknown }).onboarding === 'object'
  ) {
    return (config as { onboarding?: Onboarding }).onboarding;
  }

  return undefined;
}

function normalizeValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseDotEnv(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0) {
      entries[key] = value;
    }
  }

  return entries;
}

function readOptionalEnvFile(envPath: string, runtime: Runtime): Record<string, string> {
  try {
    return parseDotEnv(runtime.storage.readFileSync(envPath, 'utf-8'));
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return {};
    }

    throw error;
  }
}

function onboardingEnvSnapshot(onboarding: Onboarding, runtime: Runtime): Record<string, string> {
  const merged = readOptionalEnvFile(onboarding.envPath, runtime);

  for (const [key, value] of Object.entries(runtime.env.fullSnapshot())) {
    if (typeof value === 'string' && value.trim().length > 0) {
      merged[key] = value;
    }
  }

  return merged;
}

function isOnboardingSatisfied(onboarding: Onboarding, runtime: Runtime): boolean {
  const env = onboardingEnvSnapshot(onboarding, runtime);
  const provider = normalizeValue(env[onboarding.providerEnvKey]);
  if (provider === null) {
    return false;
  }

  const rule =
    onboarding.requiredEnv.find((entry) => entry.provider === provider) ??
    onboarding.requiredEnv.find((entry) => entry.provider === 'default');
  if (!rule) {
    return false;
  }

  return rule.env.every((key) => normalizeValue(env[key]) !== null);
}

function maybeAttachOnboarding(
  result: InstallResult,
  binding: CatalogBinding<unknown>,
  ctx: ExpansionInstallContext,
): InstallResult {
  const onboarding =
    'onboarding' in result && result.onboarding !== undefined
      ? result.onboarding
      : resolveOnboarding(binding.resolveConfig(ctx.runtime));
  if (onboarding === undefined) {
    return result;
  }

  return installResultSchema.parse({
    ...result,
    onboarding: {
      ...onboarding,
      localRuntime: {
        ...onboarding.localRuntime,
        targetDir: kbRuntimeDir(ctx.runtime.flavor),
      },
    },
  });
}

function buildEquipmentEntry(
  binding: CatalogBinding<unknown>,
  ctx: ExpansionInstallContext,
  passive: EquipmentView | null,
  coordinatorUnavailable: boolean,
): CatalogEntry {
  const config = binding.resolveConfig(ctx.runtime);
  const localInstalled = binding.strategy.isInstalled(ctx, config);
  const installLocked = installLockExists(ctx, binding.entry.id);
  const version = binding.strategy.currentVersion(ctx, config) ?? undefined;
  const onboarding = resolveOnboarding(config);
  const durableLocalState = version !== undefined || hasDurableEquipmentState(ctx, binding.entry.id);

  let status: Extract<
    CatalogEntry['status'],
    | 'inactive'
    | 'installed-not-active'
    | 'unavailable'
    | 'disabled_pending_reinstall'
    | 'installing'
    | 'equipped'
    | 'catching_up'
    | 'not_equipped'
  >;
  let statusDescription: string | undefined;
  if (passive !== null) {
    status = passive.status;
    statusDescription =
      passive.status === 'installed-not-active' && passive.lastError
        ? `${equipmentStatusDescription(binding.entry, passive.status)} Last error: ${passive.lastError}`
        : equipmentStatusDescription(binding.entry, passive.status);
  } else if (installLocked) {
    status = 'installing';
    statusDescription = equipmentStatusDescription(binding.entry, status);
  } else if (localInstalled) {
    status = 'inactive';
    statusDescription = coordinatorUnavailable
      ? `Installed locally, but the coordinator is unavailable. Restart Coral; if ${binding.entry.id} does not reappear, run ${equipCommand(binding.entry.id)}.`
      : equipmentStatusDescription(binding.entry, status);
  } else if (coordinatorUnavailable && durableLocalState) {
    status = 'unavailable';
    statusDescription = `Coordinator unavailable. Previously installed metadata exists, but the local binary is missing. Run ${equipCommand(binding.entry.id)} after Coral is running.`;
  } else {
    status = 'not_equipped';
    statusDescription = equipmentStatusDescription(binding.entry, status);
  }

  return catalogEntrySchema.parse({
    ...binding.entry,
    status,
    statusDescription,
    ...(passive?.lastError === undefined ? {} : { lastError: passive.lastError }),
    addonPath: ctx.runtime.paths.coral.equipment.addonPath(binding.entry.id),
    ...(version === undefined ? {} : { version }),
    ...(onboarding === undefined ? {} : { onboarding }),
  });
}

function buildInstallOnlyEntry(binding: CatalogBinding<unknown>, ctx: ExpansionInstallContext): CatalogEntry {
  const config = binding.resolveConfig(ctx.runtime);
  const installState =
    binding.strategyKind === 'github-binary'
      ? inspectGithubBinaryInstall(ctx, config as GithubBinaryConfig)
      : {
          installed: binding.strategy.isInstalled(ctx, config),
          version: binding.strategy.currentVersion(ctx, config),
          method: null,
          command: null,
        };
  const status = installLockExists(ctx, binding.entry.id)
    ? 'installing'
    : installState.installed
      ? 'installed'
      : 'not_installed';
  const version = installState.version ?? undefined;

  return catalogEntrySchema.parse({
    ...binding.entry,
    status,
    statusDescription: INSTALL_ONLY_STATUS_DESCRIPTIONS[status],
    ...(version === undefined ? {} : { version }),
    ...(installState.method === null ? {} : { method: installState.method }),
    ...(installState.command === null ? {} : { command: installState.command }),
  });
}

function shouldPauseForOnboarding(
  result: InstallResult,
  runtime: Runtime,
): result is Extract<InstallResult, { onboarding?: Onboarding }> {
  return (
    'onboarding' in result && result.onboarding !== undefined && !isOnboardingSatisfied(result.onboarding, runtime)
  );
}

export async function list(opts: WorkflowOptions = {}): Promise<InstallResponse> {
  try {
    const ctx = createContext(opts.runtime, opts.logger);
    const bindings = listCatalogEntries();
    const passive = bindings.some((binding) => binding.entry.activation === 'equipment')
      ? await readEquipmentStatusWithDeps(undefined, opts.activation)
      : { status: 'available' as const, equipment: [] };
    const equipmentByName =
      passive.status === 'available' ? new Map(passive.equipment.map((entry) => [entry.name, entry])) : null;

    return catalogResultSchema.parse({
      status: 'catalog',
      packages: bindings.map((binding) => {
        if (binding.entry.activation === 'equipment') {
          return buildEquipmentEntry(
            binding,
            ctx,
            equipmentByName?.get(binding.entry.id) ?? null,
            passive.status === 'unavailable',
          );
        }

        return buildInstallOnlyEntry(binding, ctx);
      }),
    });
  } catch (error: unknown) {
    return encodeInstallError(error);
  }
}

export async function info(name: string, opts: WorkflowOptions = {}): Promise<InstallResponse> {
  try {
    const binding = getCatalogEntry(name);
    if (binding === null) {
      return unknownEquipmentResponse(name);
    }

    const ctx = createContext(opts.runtime, opts.logger);
    const pkg =
      binding.entry.activation === 'equipment'
        ? (() => {
            const read = readEquipmentStatusWithDeps(name, opts.activation);
            return read.then((passive) =>
              buildEquipmentEntry(
                binding,
                ctx,
                passive.status === 'available' ? (passive.equipment[0] ?? null) : null,
                passive.status === 'unavailable',
              ),
            );
          })()
        : Promise.resolve(buildInstallOnlyEntry(binding, ctx));

    return infoResultSchema.parse({
      status: 'info',
      package: await pkg,
    });
  } catch (error: unknown) {
    return encodeInstallError(error);
  }
}

export async function equip(name: string, opts: WorkflowOptions = {}): Promise<InstallResponse> {
  try {
    const binding = getCatalogEntry(name);
    if (binding === null) {
      return unknownEquipmentResponse(name);
    }

    const ctx = createContext(opts.runtime, opts.logger);
    const installResult = await installExpansionWithOptions(name, buildMutationOptions(ctx, opts));
    if (installResult.status === 'error') {
      return installResult;
    }

    const result = maybeAttachOnboarding(installResult, binding, ctx);
    if (shouldPauseForOnboarding(result, ctx.runtime)) {
      return result;
    }

    if (binding.entry.activation === 'none') {
      return result;
    }

    return await activateExpansionWithDeps(name, opts.activation);
  } catch (error: unknown) {
    return encodeInstallError(error);
  }
}

export async function unequip(name: string, opts: WorkflowOptions = {}): Promise<InstallResponse> {
  try {
    const binding = getCatalogEntry(name);
    if (binding === null) {
      return unknownEquipmentResponse(name);
    }

    const ctx = createContext(opts.runtime, opts.logger);
    if (binding.entry.activation === 'equipment') {
      const passive = await readEquipmentStatusWithDeps(name, opts.activation);
      const currentStatus = passive.status === 'available' ? passive.equipment[0]?.status : undefined;
      if (currentStatus === 'equipped' || currentStatus === 'catching_up' || currentStatus === 'installed-not-active') {
        await deactivateExpansionWithDeps(name, opts.activation);
      }
    }

    return await uninstallExpansionWithOptions(name, buildMutationOptions(ctx, opts));
  } catch (error: unknown) {
    return encodeInstallError(error);
  }
}

export async function update(name: string, opts: WorkflowOptions = {}): Promise<InstallResponse> {
  try {
    const binding = getCatalogEntry(name);
    if (binding === null) {
      return unknownEquipmentResponse(name);
    }

    const ctx = createContext(opts.runtime, opts.logger);
    const installResult = await installExpansionWithOptions(name, buildMutationOptions(ctx, opts, { update: true }));
    if (installResult.status === 'error') {
      return installResult;
    }

    const result = maybeAttachOnboarding(installResult, binding, ctx);
    if (result.status === 'already_up_to_date') {
      return result;
    }

    if (shouldPauseForOnboarding(result, ctx.runtime)) {
      return result;
    }

    if (binding.entry.activation === 'none') {
      return result;
    }

    return await activateExpansionWithDeps(name, opts.activation);
  } catch (error: unknown) {
    return encodeInstallError(error);
  }
}
