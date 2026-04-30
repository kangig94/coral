import type { JobStore } from './store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionLookup } from '../sessions/lookup.js';

export type JobsStartupContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: JobStore;
  providerRegistry: ProviderCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  assertStartupStillActive: () => void;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
  sessionLookup: SessionLookup;
};

export interface JobsRecoveryCoordinator {
  runStartupRecovery(ctx: JobsStartupContext): Promise<void>;
}

export type JobsStartupDeps = JobsStartupContext & {
  recoveryCoordinator: JobsRecoveryCoordinator;
};

export async function runJobsStartup({ recoveryCoordinator, ...deps }: JobsStartupDeps): Promise<void> {
  await recoveryCoordinator.runStartupRecovery(deps);
}

export const jobsReconcile = {
  runStartup: runJobsStartup,
} as const;
