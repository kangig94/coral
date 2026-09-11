import type { JobStore } from './store.js';
import type { RecoveryCapableService } from './reconcile/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { Runtime } from '../runtime/ports.js';
import type { InterruptedAppServerReason } from './reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../store/append.js';
import type { LaunchPermit } from './contracts/admission.js';
import type {
  ProviderOperationBindingRefusal,
  ProviderOperationPrepareResult,
  ProviderOperationSettlementResult,
} from './contracts/provider-operation-lifecycle.js';
import type { ProviderOperationIdentity, ProviderOperationRecord } from '../store/provider-operation-record.js';
import type { ProviderOperationRemedy } from '../recovery/provider-operation-remedy.js';

/** A refused startup association must carry the remedy that can end its ownership hold. */
type ProviderOperationStartupBindingRefusal = Readonly<{
  kind: 'refused';
  reason: string;
  remedy: ProviderOperationRemedy;
}>;

type ProviderOperationStartupNotReconciled = Readonly<{
  kind: 'not-reconciled';
  reason: 'record-absent';
  owner:
    | Readonly<{ kind: 'generic-job-recovery' }>
    | Readonly<{ kind: 'provider-operation-recovery'; holder: LaunchPermit['holder'] }>
    | Readonly<{ kind: 'transferred-launch'; holder: LaunchPermit['holder'] }>;
}>;

type ProviderOperationPreparationDisposition =
  | Exclude<ProviderOperationPrepareResult, ProviderOperationBindingRefusal>
  | ProviderOperationStartupBindingRefusal
  | ProviderOperationStartupNotReconciled;

export type ProviderOperationSettlementDisposition =
  | Exclude<ProviderOperationSettlementResult, ProviderOperationBindingRefusal>
  | ProviderOperationStartupBindingRefusal
  | ProviderOperationStartupNotReconciled;

export type ProviderOperationStartupBindingDisposition =
  | ProviderOperationPreparationDisposition
  | ProviderOperationSettlementDisposition
  | Readonly<{ kind: 'not-required'; owner: 'prestart-cleanup' | 'generic-job-recovery' }>;

type ProviderOperationPreparationPhase = Exclude<
  ProviderOperationRecord['phase'],
  'settlement-pending' | 'local-recovery-pending' | 'prestart-cleanup-pending'
>;

type ProviderOperationStartupOwnershipFor<
  Phase extends ProviderOperationRecord['phase'],
  Disposition extends ProviderOperationStartupBindingDisposition,
> = Readonly<{
  phase: Phase;
  operation: ProviderOperationIdentity;
  restoredPermit: LaunchPermit | null;
  bindingDisposition: Disposition;
}>;

/** Reconciliation may drive an operation only after this phase-specific ownership disposition authorizes it. */
export type ProviderOperationStartupRecordOwnership =
  | ProviderOperationStartupOwnershipFor<ProviderOperationPreparationPhase, ProviderOperationPreparationDisposition>
  | ProviderOperationStartupOwnershipFor<'settlement-pending', ProviderOperationSettlementDisposition>
  | ProviderOperationStartupOwnershipFor<
      'local-recovery-pending',
      | ProviderOperationStartupBindingRefusal
      | ProviderOperationStartupNotReconciled
      | Readonly<{ kind: 'not-required'; owner: 'generic-job-recovery' }>
    >
  | ProviderOperationStartupOwnershipFor<
      'prestart-cleanup-pending',
      | ProviderOperationStartupBindingRefusal
      | ProviderOperationStartupNotReconciled
      | Readonly<{ kind: 'not-required'; owner: 'prestart-cleanup' }>
    >;

/** An unreadable row's permit cannot be released by operation identity until repair supplies that identity. */
export type ProviderOperationUnreadableStartupOwnership = Readonly<{
  recordKey: string;
  revision: string;
  jobId: string;
  restoredPermit: LaunchPermit | null;
}>;

export type ProviderOperationStartupHold =
  | Readonly<{
      kind: 'operation';
      jobId: string;
      operationId: string;
      reason: string;
      remedy: Extract<ProviderOperationStartupBindingDisposition, { kind: 'refused' }>['remedy'];
    }>
  | Readonly<{
      kind: 'unreadable-record';
      jobId: string;
      recordKey: string;
      reason: string;
      remedy: Extract<ProviderOperationStartupBindingDisposition, { kind: 'refused' }>['remedy'];
    }>;

export type ProviderOperationStartupOwnership = Readonly<{
  completion:
    | Readonly<{ kind: 'complete' }>
    | Readonly<{ kind: 'held'; holds: readonly ProviderOperationStartupHold[] }>;
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

export type JobsStartupRecoveryDisposition =
  | Readonly<{ kind: 'complete'; progressStore: JobStore }>
  | Readonly<{
      kind: 'held';
      progressStore: JobStore;
      providerOperationHolds: readonly ProviderOperationStartupHold[];
      durableContainmentHeld: boolean;
    }>;

export type RunJobsStartupFn = (inputs: JobsStartupContext) => Promise<JobsStartupRecoveryDisposition>;

export function createJobsStartupRunner(runCoordinatorStartupRecovery: RunJobsStartupFn): RunJobsStartupFn {
  return (inputs) => runCoordinatorStartupRecovery(inputs);
}
