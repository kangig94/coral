import type { ProgressStore } from './job-store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { RecoveryCoordinator } from './reconcile/coordinator.js';
import type { SessionLookup } from '../sessions/lookup.js';

export type JobsStartupDeps = {
  recoveryCoordinator: RecoveryCoordinator;
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: ProgressStore;
  providerRegistry: ProviderCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  assertStartupStillActive: () => void;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
  sessionLookup: SessionLookup;
};

export async function runJobsStartup({
  recoveryCoordinator,
  ...deps
}: JobsStartupDeps): Promise<void> {
  await recoveryCoordinator.runStartupRecovery(deps);
}

export const jobsReconcile = {
  runStartup: runJobsStartup,
} as const;
