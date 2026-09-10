import type { JobStore } from './store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { InterruptedAppServerReason } from './reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../store/append.js';
import type { LaunchPermit, OperationBindingResult } from './contracts/admission.js';
import type { ProviderOperationIdentity, ProviderOperationRecord } from '../store/provider-operation-record.js';

/** A refused startup association must name the event that can end its ownership hold. */
export type ProviderOperationStartupBindingDisposition =
  | Exclude<OperationBindingResult, Readonly<{ kind: 'refused'; reason: string }>>
  | Readonly<{
      kind: 'refused';
      reason: string;
      exit: 'restart-or-operator-repair' | 'remote-settlement';
    }>
  | Readonly<{ kind: 'not-required'; owner: 'prestart-cleanup' | 'generic-job-recovery' }>
  | Readonly<{ kind: 'not-reconciled'; reason: 'record-absent' }>;

/** Reconciliation may drive an operation only after this phase-specific ownership disposition authorizes it. */
export type ProviderOperationStartupRecordOwnership = Readonly<{
  phase: ProviderOperationRecord['phase'];
  operation: ProviderOperationIdentity;
  restoredPermit: LaunchPermit | null;
  bindingDisposition: ProviderOperationStartupBindingDisposition;
}>;

/** An unreadable row's permit cannot be released by operation identity until repair supplies that identity. */
export type ProviderOperationUnreadableStartupOwnership = Readonly<{
  recordKey: string;
  jobId: string;
  restoredPermit: LaunchPermit | null;
}>;

/** Hydrated ownership presented to provider reconciliation; generic recovery re-snapshots after that owner runs. */
export type ProviderOperationStartupOwnership = Readonly<{
  /** Jobs fenced at hydration time, before provider reconciliation may accept or release them. */
  jobIds: readonly string[];
  records: readonly ProviderOperationStartupRecordOwnership[];
  unreadable: readonly ProviderOperationUnreadableStartupOwnership[];
}>;

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
  providerOperationStartupOwnership: ProviderOperationStartupOwnership;
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
