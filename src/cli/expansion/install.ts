import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import { INSTALL_ONLY_PACKAGES } from '../../expansion/install-only.js';
import { createExpansionManifestCatalog } from '../../expansion/manifest/catalog.js';
import { parseEngineManifest } from '../../expansion/manifest/schema.js';
import type { EngineInstaller, EngineInstallerOptions, LocalExpansionInstallState } from '../../expansion/contract.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { createRealRuntime } from '../../runtime/real.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
import { openWritableStoreDbNoReset } from '../../store/db.js';
import { currentCoralStoreFormat } from '../../store-format.js';
import { isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import { acquirePackageOperationLock, PACKAGE_OPERATION_LOCK_TIMEOUT_MS } from '../../expansion/package-lock.js';
import {
  installErrorSchema,
  installResponseSchema,
  type InstallError,
  type InstallResponse,
} from '../../expansion/rpc-contract.js';

export type InstallExpansionOptions = Partial<
  Pick<EngineInstallerOptions, 'runtime' | 'logger' | 'lockTimeoutMs' | 'update'>
>;
export type UninstallExpansionOptions = Partial<Pick<EngineInstallerOptions, 'runtime' | 'logger' | 'lockTimeoutMs'>>;

export function resolveRuntime(runtime?: Runtime): Runtime {
  return runtime ?? createRealRuntime(resolveBuildFlavor(process.env));
}

function toInstallError(code: Parameters<typeof documentedCoralSetupError>[0], name: string): InstallError {
  const error = documentedCoralSetupError(code, { name });
  return installErrorSchema.parse({
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  });
}

function genericInstallState(runtime: Runtime, name: string): LocalExpansionInstallState {
  return {
    targetDir: runtime.paths.coral.engine.dataDir(name),
    addonPath: null,
    installLockPath: runtime.paths.coral.engine.installLockPath(name),
    version: null,
    method: null,
    installed: false,
    installLocked: false,
    durableState: false,
  };
}

type InstallerPackage = { readonly version: string; readonly installer: EngineInstaller };

function resolveInstallerPackage(name: string): InstallerPackage | null {
  const engine = BUNDLED_ENGINES.find((candidate) => candidate.id === name);
  if (engine?.installer) {
    return { version: engine.version, installer: engine.installer };
  }
  const installOnly = INSTALL_ONLY_PACKAGES.find((candidate) => candidate.id === name);
  return installOnly === undefined ? null : { version: installOnly.version, installer: installOnly.installer };
}

export function inspectExpansionInstallState(runtime: Runtime, name: string): LocalExpansionInstallState {
  return resolveInstallerPackage(name)?.installer.inspect(runtime, name) ?? genericInstallState(runtime, name);
}

async function applyPostInstallCatalogActions(
  result: InstallResponse,
  runtime: Runtime,
  name: string,
): Promise<InstallResponse> {
  if (!('postInstall' in result) || result.postInstall === undefined) {
    return result;
  }

  const structuredActions = result.postInstall.filter(
    (action): action is { readonly action: 'register_expansion'; readonly manifestPath: string } =>
      typeof action === 'object' && action !== null && action.action === 'register_expansion',
  );
  if (structuredActions.length === 0) {
    return result;
  }
  if (structuredActions.length !== 1) {
    throw new Error(`Expansion package '${name}' returned multiple catalog registrations`);
  }

  const db = openWritableStoreDbNoReset(runtime, { storeFormat: currentCoralStoreFormat() });
  try {
    const catalog = createExpansionManifestCatalog({ db });
    for (const action of structuredActions) {
      const baseDir = result.targetDir ?? runtime.paths.coral.engine.dataDir(name);
      const manifestPath = isAbsolute(action.manifestPath) ? action.manifestPath : join(baseDir, action.manifestPath);
      const manifest = parseEngineManifest(JSON.parse(runtime.storage.readFileSync(manifestPath, 'utf-8')) as unknown);
      if (manifest.id !== name) {
        throw new Error(`Expansion package '${name}' cannot register manifest '${manifest.id}'`);
      }
      catalog.upsertInstalledEntry(manifest);
    }
  } finally {
    db.close();
  }

  return result;
}

export async function installExpansion(name: string, opts: InstallExpansionOptions = {}): Promise<InstallResponse> {
  const pkg = resolveInstallerPackage(name);
  if (!pkg) {
    return toInstallError('unknown_expansion', name);
  }

  const runtime = resolveRuntime(opts.runtime);
  let release: () => void;
  try {
    release = await acquirePackageOperationLock(runtime, name, opts.lockTimeoutMs ?? PACKAGE_OPERATION_LOCK_TIMEOUT_MS);
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', name);
    }
    throw error;
  }
  try {
    const result = installResponseSchema.parse(
      await pkg.installer.install({
        name,
        version: pkg.version,
        runtime,
        logger: opts.logger,
        lockTimeoutMs: opts.lockTimeoutMs,
        update: opts.update,
        operationLockHeld: true,
      }),
    );
    return await applyPostInstallCatalogActions(result, runtime, name);
  } finally {
    release();
  }
}

export async function removeInstallArtifacts(runtime: Runtime, name: string): Promise<void> {
  rmSync(runtime.paths.coral.engine.dataDir(name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function uninstallExpansion(name: string, opts: UninstallExpansionOptions = {}): Promise<InstallResponse> {
  const pkg = resolveInstallerPackage(name);
  if (!pkg) {
    return toInstallError('unknown_expansion', name);
  }

  const runtime = resolveRuntime(opts.runtime);
  let release: () => void;
  try {
    release = await acquirePackageOperationLock(runtime, name, opts.lockTimeoutMs ?? PACKAGE_OPERATION_LOCK_TIMEOUT_MS);
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', name);
    }
    throw error;
  }
  try {
    return installResponseSchema.parse(
      await pkg.installer.uninstall({
        name,
        version: pkg.version,
        runtime,
        logger: opts.logger,
        lockTimeoutMs: opts.lockTimeoutMs,
        operationLockHeld: true,
      }),
    );
  } finally {
    release();
  }
}
