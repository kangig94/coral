import { rmSync } from 'node:fs';

import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import type { EngineInstallerOptions, LocalExpansionInstallState } from '../../expansion/contract.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { createRealRuntime } from '../../runtime/real.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
import { installErrorSchema, installResponseSchema, type InstallError, type InstallResponse } from './contract.js';

export type InstallExpansionOptions = Partial<
  Pick<EngineInstallerOptions, 'runtime' | 'logger' | 'lockTimeoutMs' | 'update'>
>;
export type UninstallExpansionOptions = Partial<Pick<EngineInstallerOptions, 'runtime' | 'logger' | 'lockTimeoutMs'>>;

function resolveRuntime(runtime?: Runtime): Runtime {
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

export function inspectExpansionInstallState(runtime: Runtime, name: string): LocalExpansionInstallState {
  const entry = BUNDLED_ENGINES.find((candidate) => candidate.id === name);
  return entry?.installer?.inspect(runtime, name) ?? genericInstallState(runtime, name);
}

export async function installExpansion(name: string, opts: InstallExpansionOptions = {}): Promise<InstallResponse> {
  const entry = BUNDLED_ENGINES.find((candidate) => candidate.id === name);
  if (!entry?.installer) {
    return toInstallError('unknown_expansion', name);
  }

  return installResponseSchema.parse(
    await entry.installer.install({
      name,
      version: entry.version,
      runtime: resolveRuntime(opts.runtime),
      logger: opts.logger,
      lockTimeoutMs: opts.lockTimeoutMs,
      update: opts.update,
    }),
  );
}

export async function removeInstallArtifacts(runtime: Runtime, name: string): Promise<void> {
  rmSync(runtime.paths.coral.engine.dataDir(name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function uninstallExpansion(name: string, opts: UninstallExpansionOptions = {}): Promise<InstallResponse> {
  const entry = BUNDLED_ENGINES.find((candidate) => candidate.id === name);
  if (!entry?.installer) {
    return toInstallError('unknown_expansion', name);
  }

  return installResponseSchema.parse(
    await entry.installer.uninstall({
      name,
      version: entry.version,
      runtime: resolveRuntime(opts.runtime),
      logger: opts.logger,
      lockTimeoutMs: opts.lockTimeoutMs,
    }),
  );
}
