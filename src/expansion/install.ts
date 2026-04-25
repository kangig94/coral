import { rmSync } from 'node:fs';

import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { acquireDirectoryLock, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { InstallError, InstallResponse, InstallResult } from './contracts.js';
import { installErrorSchema } from './contracts.js';
import { CATALOG } from './catalog.js';
import { createExpansionInstallContext, type ExpansionInstallContext } from './strategies/strategy.js';

const EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS = 250;

export interface InstallExpansionOptions {
  readonly runtime?: Runtime;
  readonly logger?: ExpansionInstallContext['logger'];
  readonly lockTimeoutMs?: number;
  readonly update?: boolean;
}

export interface UninstallExpansionOptions {
  readonly runtime?: Runtime;
  readonly logger?: ExpansionInstallContext['logger'];
  readonly lockTimeoutMs?: number;
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

function resolveBinding(name: string) {
  return CATALOG[name as keyof typeof CATALOG] ?? null;
}

function createContext(opts: InstallExpansionOptions = {}): ExpansionInstallContext {
  return createExpansionInstallContext(opts.runtime ?? createRealRuntime(resolveBuildFlavor(process.env)), opts.logger);
}

function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String((error as NodeJS.ErrnoException).code))
  );
}

async function uninstallArtifactsLocked(name: string, ctx: ExpansionInstallContext): Promise<InstallResult> {
  const binding = resolveBinding(name);
  if (!binding) {
    throw documentedCoralSetupError('unknown_equipment', { name });
  }
  return await binding.strategy.uninstall(ctx, binding.resolveConfig(ctx.runtime));
}

async function withInstallLock<T>(
  name: string,
  ctx: ExpansionInstallContext,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T | InstallError> {
  const targetDir = ctx.runtime.paths.coral.equipment.dataDir(name);
  const lockPath = ctx.runtime.paths.coral.equipment.installLockPath(name);
  ctx.runtime.storage.mkdirSync(targetDir, { recursive: true });

  let release: () => void;
  try {
    release = await acquireDirectoryLock(
      lockPath,
      {
        storage: ctx.runtime.storage,
        time: ctx.runtime.time,
      },
      timeoutMs,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('equipment_install_lock_contended', name);
    }
    throw error;
  }

  try {
    return await run();
  } finally {
    release();
  }
}

export async function installExpansion(name: string, opts: InstallExpansionOptions = {}): Promise<InstallResponse> {
  const binding = resolveBinding(name);
  if (!binding) {
    return toInstallError('unknown_equipment', name);
  }

  const ctx = createContext(opts);
  try {
    const response = await withInstallLock(
      name,
      ctx,
      opts.lockTimeoutMs ?? EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS,
      async () => await binding.strategy.install(ctx, binding.resolveConfig(ctx.runtime), { update: opts.update }),
    );
    return response;
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return toInstallError('equipment_install_path_unwritable', name);
    }
    throw error;
  }
}

export async function removeInstallArtifacts(runtime: Runtime, name: string): Promise<void> {
  rmSync(runtime.paths.coral.equipment.dataDir(name), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

export async function uninstallExpansion(name: string, opts: UninstallExpansionOptions = {}): Promise<InstallResponse> {
  const binding = resolveBinding(name);
  if (!binding) {
    return toInstallError('unknown_equipment', name);
  }

  const ctx = createExpansionInstallContext(opts.runtime ?? createRealRuntime(resolveBuildFlavor(process.env)), opts.logger);
  try {
    const response = await withInstallLock(
      name,
      ctx,
      opts.lockTimeoutMs ?? EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS,
      async () => {
        return await uninstallArtifactsLocked(name, ctx);
      },
    );
    return response;
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return toInstallError('equipment_install_path_unwritable', name);
    }
    throw error;
  }
}
