import type { Runtime } from '../../runtime/ports.js';
import type { InstallResult } from '../contracts.js';

export type ExpansionLoggerEvent = {
  kind: string;
  message: string;
};

export interface ExpansionInstallContext {
  runtime: Runtime;
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

export function createExpansionInstallContext(
  runtime: Runtime,
  logger?: ExpansionInstallContext['logger'],
): ExpansionInstallContext {
  return {
    runtime,
    ...(logger === undefined ? {} : { logger }),
  };
}

export function logStrategyEvent(ctx: ExpansionInstallContext, kind: string, message: string): void {
  ctx.logger?.({ kind, message });
}
