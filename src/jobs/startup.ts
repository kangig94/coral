import type { JobStore } from './store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { SessionLookup } from '../sessions/lookup.js';
import type { InterruptedAppServerReason } from './reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../store/append.js';

type JobsStartupContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: JobStore;
  providerRegistry: ProviderCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
  sessionLookup: SessionLookup;
  coordinatorCommit: CommitEventsFn;
  /**
   * Why the recovery is finalizing app-server jobs:
   * - `'restart'` (default): ordinary process restart recovery.
   * - `'handoff'`: replacement daemon swap (set when `bindWithHandoff`
   *   observed and acquired the socket from an incumbent).
   *
   * The reason is forwarded to `finalizeInterruptedAppServerJob` and becomes
   * the durable session interruption trigger.
   */
  interruptedAppServerReason?: InterruptedAppServerReason;
};

interface JobsRecoveryCoordinator {
  runStartupRecovery(ctx: JobsStartupContext): Promise<JobStore>;
}

type JobsStartupDeps = JobsStartupContext & {
  recoveryCoordinator: JobsRecoveryCoordinator;
};

async function runJobsStartup({ recoveryCoordinator, ...deps }: JobsStartupDeps): Promise<JobStore> {
  return recoveryCoordinator.runStartupRecovery(deps);
}

export const jobsReconcile = {
  runStartup: runJobsStartup,
} as const;
