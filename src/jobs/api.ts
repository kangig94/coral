import type { ProgressStore } from './job-store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { CallerContext } from '../transport/request-context.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from '../runtime/ports.js';
import type { RecoveryCoordinator } from './reconcile/coordinator.js';
import type { SessionLookup } from '../sessions/lookup.js';

export type JobsStartupDeps = {
  recoveryCoordinator: RecoveryCoordinator;
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: ProgressStore;
  providerRegistry: ProviderRegistry;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  createCallerContext: (projectRoot: string) => CallerContext;
  assertStartupStillActive: () => void;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
  sessionLookup: SessionLookup;
};

export const jobsReconcile = {
  async runStartup({
    recoveryCoordinator,
    ...deps
  }: JobsStartupDeps): Promise<void> {
    await recoveryCoordinator.runStartupRecovery(deps);
  },
} as const;

export type { ProgressStore } from './job-store.js';
