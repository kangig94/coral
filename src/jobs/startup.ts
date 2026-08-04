import type { JobStore } from './store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { InterruptedAppServerReason } from './reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../store/append.js';

export type JobsStartupContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: JobStore;
  providerRegistry: ProviderCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
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

export type RunJobsStartupFn = (inputs: JobsStartupContext) => Promise<JobStore>;

export function createJobsStartupRunner(runCoordinatorStartupRecovery: RunJobsStartupFn): RunJobsStartupFn {
  return (inputs) => runCoordinatorStartupRecovery(inputs);
}
