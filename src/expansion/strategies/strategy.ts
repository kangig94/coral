import { join } from 'node:path';

import type { Runtime } from '../../runtime/ports.js';
import type { InstallResult } from '../contracts.js';
import {
  equipmentAddonPath as resolveEquipmentAddonPath,
  equipmentDataDir as resolveEquipmentDataDir,
  equipmentInstallLockPath as resolveEquipmentInstallLockPath,
} from '../../infra/equipment-paths.js';

export type ExpansionLoggerEvent = {
  kind: string;
  message: string;
};

export interface ExpansionPathHelpers {
  equipmentDataDir(name: string): string;
  equipmentAddonPath(name: string): string;
  equipmentInstallLockPath(name: string): string;
}

export interface ExpansionInstallContext {
  runtime: Runtime;
  paths: ExpansionPathHelpers;
  logger?: (event: ExpansionLoggerEvent) => void;
}

export interface StrategyInstallOptions {
  update?: boolean;
}

export interface Strategy<Config> {
  install(ctx: ExpansionInstallContext, config: Config, opts?: StrategyInstallOptions): Promise<InstallResult>;
  uninstall(ctx: ExpansionInstallContext, config: Config): Promise<InstallResult>;
  isInstalled(ctx: ExpansionInstallContext, config: Config): boolean;
  currentVersion(ctx: ExpansionInstallContext, config: Config): string | null;
}

export function createExpansionPathHelpers(runtime: Runtime): ExpansionPathHelpers {
  const env = runtime.env.fullSnapshot();
  const baseDir = join(runtime.env.homedir(), '.coral');

  return {
    equipmentDataDir: (name) => resolveEquipmentDataDir(name, { baseDir, env }),
    equipmentAddonPath: (name) => resolveEquipmentAddonPath(name, { baseDir, env }),
    equipmentInstallLockPath: (name) => resolveEquipmentInstallLockPath(name, { baseDir, env }),
  };
}

export function createExpansionInstallContext(
  runtime: Runtime,
  logger?: ExpansionInstallContext['logger'],
): ExpansionInstallContext {
  return {
    runtime,
    paths: createExpansionPathHelpers(runtime),
    ...(logger === undefined ? {} : { logger }),
  };
}

export function logStrategyEvent(ctx: ExpansionInstallContext, kind: string, message: string): void {
  ctx.logger?.({ kind, message });
}
