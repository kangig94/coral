import { planRecovery } from '../../../jobs/reconcile/plan.js';
import { RecoveryRegistry, type RecoveryAbortDisposition } from '../../../jobs/reconcile/registry.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { JobStore } from '../../../jobs/store.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type { RecoveryDisposition } from '../../../recovery/containment.js';
import {
  applyRecoveryAction,
  logRecoveryActionFailure,
  COORDINATOR_NOT_APPLICABLE_FACTS,
  type QueuedRecoverableJob,
  type RunningRecoverableJob,
} from './actions.js';
import { buildRecoverySnapshot, type CoordinatorRecoveryItem } from './snapshot.js';
import type { RecoveryAdoption } from './adoption.js';
import type { RecoveryCoordinatorState } from './lifecycle.js';
import type { ProviderOperationStartupOwnershipService } from './provider-operation-startup-ownership.js';
import type { CoordinatorRecoveryControls } from './walk.js';
import type { createRecoveryWalk } from './walk.js';

export type ProviderOperationRecoveryAcceptance = Readonly<{
  state: 'accepted';
  jobId: string;
  owner: 'recovery-coordinator';
}>;

export type ProviderOperationRecoveryPlanActionOptions = Readonly<{
  itemsByJobId: ReadonlyMap<string, CoordinatorRecoveryItem>;
  itemsBySessionId: ReadonlyMap<string, CoordinatorRecoveryItem>;
  recoveryRegistry: RecoveryRegistry;
  queuedRecoverable: QueuedRecoverableJob[];
  runningRecoverable: RunningRecoverableJob[];
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
}>;

export function createProviderOperationJobRecovery(
  deps: Readonly<{
    state: RecoveryCoordinatorState;
    progressStore: JobStore;
    runtime: Runtime;
    getRecoveryService(ctx: InvocationContext): RecoveryCapableService;
    createInvocationContext(projectRoot: string): InvocationContext;
    recoveryAdoption: RecoveryAdoption;
    providerOperationStartupOwnership: Pick<ProviderOperationStartupOwnershipService, 'completeRecovery'>;
    runCoordinatorWalk: ReturnType<typeof createRecoveryWalk>['runCoordinatorWalk'];
    settleClaim: ReturnType<typeof createRecoveryWalk>['settleClaim'];
    settleFault: ReturnType<typeof createRecoveryWalk>['settleFault'];
    settleUnexpectedRecoveryFailure: ReturnType<typeof createRecoveryWalk>['settleUnexpectedRecoveryFailure'];
    maybeReleaseRecoveryRegistry(): void;
    abandonHeldJob(jobId: string): RecoveryAbortDisposition;
  }>,
) {
  const {
    state,
    progressStore,
    runtime,
    getRecoveryService,
    createInvocationContext,
    recoveryAdoption,
    providerOperationStartupOwnership,
    runCoordinatorWalk,
    settleClaim,
    settleFault,
    settleUnexpectedRecoveryFailure,
    maybeReleaseRecoveryRegistry,
    abandonHeldJob,
  } = deps;

  const applyActionToItem = async (
    action: Parameters<typeof applyRecoveryAction>[0],
    item: CoordinatorRecoveryItem,
    controls: CoordinatorRecoveryControls,
    options: ProviderOperationRecoveryPlanActionOptions,
  ): Promise<RecoveryDisposition> => {
    try {
      return await applyRecoveryAction(action, {
        progressStore,
        recoveryRegistry: options.recoveryRegistry,
        queuedRecoverable: options.queuedRecoverable,
        runningRecoverable: options.runningRecoverable,
        log: controls.report,
        runtime,
        createInvocationContext,
        getRecoveryService,
        signal: options.signal,
        settleFault: (fault, content) => settleFault(item, action.jobId, fault, options.coordinatorCommit, content),
        settleClaim: (jobId) => settleClaim(item, jobId, options.coordinatorCommit),
        setProcessLocalCleanup: controls.setProcessLocalCleanup,
        clearProcessLocalCleanup: controls.clearProcessLocalCleanup,
        abandonHeldJob: (heldJobId) => abandonHeldJob(heldJobId),
      });
    } catch (error: unknown) {
      logRecoveryActionFailure(action, error, controls.report);
      throw error;
    }
  };

  const applyPlanAction = async (
    action: Parameters<typeof applyRecoveryAction>[0],
    options: ProviderOperationRecoveryPlanActionOptions,
  ): Promise<void> => {
    const item =
      options.itemsByJobId.get(action.jobId) ??
      (action.type === 'releaseSessionClaim' ? options.itemsBySessionId.get(action.sessionId) : undefined);
    if (item === undefined) {
      throw new Error(`Recovery plan action '${action.type}' has no raw coordinator item for ${action.jobId}.`);
    }
    await runCoordinatorWalk({
      subjectKey: item.jobId,
      signal: options.signal,
      coordinatorCommit: options.coordinatorCommit,
      summary: `Coordinator recovery action ${action.type} for ${action.jobId}`,
      settle: (freshItem, controls) => applyActionToItem(action, freshItem, controls, options),
      ...(action.type === 'registerQueued' || action.type === 'registerRunning'
        ? {
            settleFailure: (
              freshItem: CoordinatorRecoveryItem,
              error: unknown,
              controls: { report(message: string): void },
            ) =>
              settleUnexpectedRecoveryFailure(
                freshItem,
                action.jobId,
                action.type === 'registerQueued'
                  ? 'Queued recovery registration failed'
                  : 'Running recovery registration failed',
                error,
                options.coordinatorCommit,
                controls.report,
              ),
          }
        : {}),
    });
  };

  const recoverProviderOperationJobOnce = async (
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecoveryAcceptance> => {
    const jobId = record.operation.jobId;
    const coordinatorCommit: CommitEventsFn = (callback) => progressStore.commit(callback);
    const freshItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      subjectKey: jobId,
      signal,
      coordinatorCommit,
      summary: `Provider operation exact-job recovery hydration for ${jobId}`,
      settle: (item) => {
        freshItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'provider operation recovery job hydrated',
        };
      },
    });
    const item = freshItems[0];
    if (item === undefined) {
      throw new Error(`Provider operation recovery job '${jobId}' is absent from the coordinator journal.`);
    }

    const plan = planRecovery(buildRecoverySnapshot([item], runtime.process));
    const recoveryRegistry = state.recoveryRegistry ?? new RecoveryRegistry(state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];
    const planActionOptions = {
      itemsByJobId: new Map([[item.jobId, item]]),
      itemsBySessionId: new Map(item.claimedSession === null ? [] : ([[item.claimedSession.sessionId, item]] as const)),
      recoveryRegistry,
      queuedRecoverable,
      runningRecoverable,
      signal,
      coordinatorCommit,
    } as const;

    for (const action of plan.register) {
      if (action.jobId === jobId) await applyPlanAction(action, planActionOptions);
    }
    for (const action of plan.cleanup) {
      if (action.jobId === jobId) await applyPlanAction(action, planActionOptions);
    }

    if (runningRecoverable.length > 0) {
      await recoveryAdoption.run({
        queuedJobs: [],
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit,
        interruptedAppServerReason: 'restart',
        abandonHeldJob: (heldJobId) => abandonHeldJob(heldJobId),
      });
    }
    for (const queued of queuedRecoverable) {
      progressStore.seedEnqueueSequence(queued.authority.launchRecord.enqueueSequence);
      await recoveryAdoption.acceptQueued(queued, signal, coordinatorCommit, 'retry');
    }
    maybeReleaseRecoveryRegistry();
    return { state: 'accepted', jobId, owner: 'recovery-coordinator' };
  };

  const recoverProviderOperationJob = (
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecoveryAcceptance> => {
    const jobId = record.operation.jobId;
    const existing = state.providerOperationRecoveries.get(jobId);
    if (existing !== undefined) return existing;

    const recovery = recoverProviderOperationJobOnce(record, signal).catch((error: unknown) => {
      if (state.providerOperationRecoveries.get(jobId) === recovery) {
        state.providerOperationRecoveries.delete(jobId);
      }
      throw error;
    });
    state.providerOperationRecoveries.set(jobId, recovery);
    return recovery;
  };

  const completeProviderOperationJobRecovery = (jobId: string): void => {
    state.providerOperationRecoveries.delete(jobId);
    providerOperationStartupOwnership.completeRecovery(jobId);
  };

  return {
    applyActionToItem,
    applyPlanAction,
    completeProviderOperationJobRecovery,
    recoverProviderOperationJob,
  };
}
