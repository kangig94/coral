import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import { planRecovery } from '../../../jobs/reconcile/plan.js';
import { RecoveryRegistry, type RecoveryAbortDisposition } from '../../../jobs/reconcile/registry.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import { withImmediate } from '../../../store/db.js';
import type { JobsStartupRecoveryDisposition, ProviderOperationStartupHold } from '../../../jobs/startup.js';
import {
  listDurableCliContainmentStatuses,
  readDurableCliContainmentStatus,
  readDurableCliProcessRuntimeEvidence,
  writeDurableCliContainmentStatus,
} from '../../../jobs/runtime-meta-store.js';
import type { DurableCliContainmentStatus } from '../../../jobs/runtime-meta.js';
import type { RecoveryDisposition, RecoverySettlementFact } from '../../../recovery/containment.js';
import { installCoordinatorJobRetryPolicy } from './retry-plans.js';
import { COORDINATOR_NOT_APPLICABLE_FACTS, type QueuedRecoverableJob, type RunningRecoverableJob } from './actions.js';
import { buildRecoverySnapshot, type CoordinatorRecoveryItem } from './snapshot.js';
import { providerOperationStartupIdentityKey } from './provider-operation-startup-ownership.js';
import type { ProviderOperationStartupOwnershipService } from './provider-operation-startup-ownership.js';
import type { RecoveryAdoption } from './adoption.js';
import type { RecoveryCoordinatorState, createRecoveryLifecycle } from './lifecycle.js';
import type {
  ProviderOperationRecoveryPlanActionOptions,
  createProviderOperationJobRecovery,
} from './provider-operation-job-recovery.js';
import type { CoordinatorRecoveryControls, createRecoveryWalk } from './walk.js';

export type StartupRecoveryContext = {
  runtime: Runtime;
  progressStore: JobStore;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason?: InterruptedAppServerReason;
};

export type RunCoordinatorStartupRecoveryFn = (ctx: StartupRecoveryContext) => Promise<JobsStartupRecoveryDisposition>;

export function createCoordinatorStartupRecovery(
  deps: Readonly<{
    state: RecoveryCoordinatorState;
    runtimeState: { setLaunchFenceActive(active: boolean): void };
    providerOperationStartupOwnership: ProviderOperationStartupOwnershipService;
    recoveryAdoption: RecoveryAdoption;
    operationRecovery: ReturnType<typeof createProviderOperationJobRecovery>;
    recoveryWalk: ReturnType<typeof createRecoveryWalk>;
    lifecycle: ReturnType<typeof createRecoveryLifecycle>;
    setAbandonHeldJob(handler: (jobId: string) => RecoveryAbortDisposition): void;
  }>,
) {
  const {
    state,
    runtimeState,
    providerOperationStartupOwnership,
    recoveryAdoption,
    operationRecovery,
    recoveryWalk,
    lifecycle,
    setAbandonHeldJob,
  } = deps;
  const { applyActionToItem, applyPlanAction, recoverProviderOperationJob } = operationRecovery;
  const { createCoordinatorJobRecoveryPolicy, deleteCoordinatorRecoveryQuarantine, runCoordinatorWalk } = recoveryWalk;
  const { cancelHeldRecoveryReap, clearRecoveryPoller, resetRecoveryState } = lifecycle;
  let abandonHeldRecoveryJob = (_jobId: string): RecoveryAbortDisposition => ({
    kind: 'refused',
    reason: 'durable containment abandonment is unavailable before recovery initialization',
  });

  async function runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobsStartupRecoveryDisposition> {
    const { runtime, progressStore, signal, log } = ctx;
    const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
    state.teardownRequested = false;
    runtimeState.setLaunchFenceActive(true);
    const recoveryRegistry = new RecoveryRegistry(state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];

    const retryCoordinatorItem = async (
      item: CoordinatorRecoveryItem,
      controls: CoordinatorRecoveryControls,
      retrySignal: AbortSignal,
    ): Promise<RecoveryDisposition> => {
      const retryQueued: QueuedRecoverableJob[] = [];
      const retryRunning: RunningRecoverableJob[] = [];
      const retryOptions: ProviderOperationRecoveryPlanActionOptions = {
        itemsByJobId: new Map([[item.jobId, item]]),
        itemsBySessionId: new Map(
          item.claimedSession === null ? [] : ([[item.claimedSession.sessionId, item]] as const),
        ),
        recoveryRegistry,
        queuedRecoverable: retryQueued,
        runningRecoverable: retryRunning,
        signal: retrySignal,
        coordinatorCommit: ctx.coordinatorCommit,
      };
      const retryPlan = planRecovery(buildRecoverySnapshot([item], runtime.process));
      let facts: readonly RecoverySettlementFact[] = [];
      for (const action of [...retryPlan.register, ...retryPlan.cleanup]) {
        if (action.jobId !== item.jobId) continue;
        const disposition = await applyActionToItem(action, item, controls, retryOptions);
        if (disposition.kind !== 'advanced') return disposition;
        facts = [...facts, ...disposition.facts];
      }
      const runningDisposition = await recoveryAdoption.run(
        {
          queuedJobs: [],
          runningJobs: retryRunning,
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          interruptedAppServerReason,
          abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
        },
        { item, controls },
      );
      if (runningDisposition !== undefined) return runningDisposition;
      const queued = retryQueued[0];
      if (queued !== undefined) {
        return recoveryAdoption.recoverQueued(item, queued, retrySignal, ctx.coordinatorCommit, controls);
      }
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts,
        detail: 'coordinator job retry reconciled',
      };
    };

    abandonHeldRecoveryJob = (jobId): RecoveryAbortDisposition => {
      const statusRead = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
      const runtimeRecord = progressStore.readRuntimeProjection(jobId);
      if (
        statusRead.kind === 'missing' ||
        (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') ||
        (statusRead.kind === 'corrupt' && (runtimeRecord === null || !isDurableCliRuntime(runtimeRecord)))
      ) {
        return { kind: 'refused', reason: 'no active durable containment hold is recorded for this job' };
      }

      const activeReapSettlement = cancelHeldRecoveryReap(jobId);
      if (activeReapSettlement !== null) {
        clearRecoveryPoller(jobId);
        return {
          kind: 'held',
          reason: 'the active durable containment reap is still settling',
          nextStep: 'Wait for containment reap settlement; abandonment will resume automatically.',
          settlement: activeReapSettlement.then(async () => {
            const resumed = abandonHeldRecoveryJob(jobId);
            if (resumed.settlement !== undefined) return resumed.settlement;
            return resumed;
          }),
        };
      }

      let abandonedStatus: DurableCliContainmentStatus;
      if (statusRead.kind === 'valid') {
        abandonedStatus = {
          ...statusRead.status,
          disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
        };
      } else {
        if (runtimeRecord === null || !isDurableCliRuntime(runtimeRecord)) {
          return { kind: 'refused', reason: 'no durable runtime identity is recorded for this job' };
        }
        abandonedStatus = {
          jobId,
          evidence: readDurableCliProcessRuntimeEvidence(progressStore.getDb(), jobId, runtimeRecord.pid),
          disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
        };
      }

      try {
        withImmediate(progressStore.getDb(), () => {
          writeDurableCliContainmentStatus(progressStore.getDb(), abandonedStatus);
          if (!deleteCoordinatorRecoveryQuarantine(jobId)) {
            throw new Error('coordinator job recovery already owns this hold retry');
          }
        });
      } catch (error: unknown) {
        return {
          kind: 'refused',
          reason: `durable containment abandonment could not be recorded: ${errorMessage(error)}`,
        };
      }
      clearRecoveryPoller(jobId);

      const jobStatus = progressStore.readStatus(jobId);
      if (jobStatus !== null) {
        try {
          progressStore.appendProgress(
            jobId,
            jobStatus.sessionId,
            'Durable containment was abandoned without proof of process absence and without sending a signal.',
          );
        } catch (error: unknown) {
          backendLog.warn(`Failed to append durable containment abandonment for ${jobId}: ${errorMessage(error)}`);
        }
      }
      if (jobStatus !== null && !isTerminalPhase(jobStatus.phase)) {
        recoveryRegistry.markCancelled(jobId);
        const finalization = runCoordinatorWalk({
          subjectKey: jobId,
          signal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: `Operator-abandoned durable recovery finalization for ${jobId}`,
          settle: (item, controls) => retryCoordinatorItem(item, controls, signal),
        });
        void finalization.catch((error: unknown) => {
          backendLog.warn(
            `Operator-abandoned durable recovery finalization failed for ${jobId}: ${errorMessage(error)}`,
          );
        });
      }
      return {
        kind: 'abandoned',
        reason: 'recovery ownership was released without proof of recorded containment absence',
        nextStep: {
          detail: 'The recorded containment may still be live and is no longer owned by recovery.',
          remedy: { kind: 'jobs-detail', jobId },
        },
      };
    };

    setAbandonHeldJob(abandonHeldRecoveryJob);

    for (const statusRead of listDurableCliContainmentStatuses(progressStore.getDb())) {
      if (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') continue;
      const jobId = statusRead.kind === 'valid' ? statusRead.status.jobId : statusRead.jobId;
      const launchRecord = progressStore.readLaunchProjection(jobId);
      const runtimeRecord = progressStore.readRuntimeProjection(jobId);
      const jobStatus = progressStore.readStatus(jobId);
      if (
        launchRecord === null ||
        runtimeRecord === null ||
        !isDurableCliRuntime(runtimeRecord) ||
        jobStatus === null
      ) {
        continue;
      }
      if (statusRead.kind === 'valid' && !deleteCoordinatorRecoveryQuarantine(jobId)) continue;
      recoveryRegistry.register(jobId, launchRecord, runtimeRecord, () => abandonHeldRecoveryJob(jobId));
    }

    installCoordinatorJobRetryPolicy(progressStore.getDb(), (retrySignal) =>
      createCoordinatorJobRecoveryPolicy(
        {
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: 'Coordinator job operator retry',
          settle: (item, controls) => retryCoordinatorItem(item, controls, retrySignal),
        },
        [],
      ),
    );
    const walkedRecoveryItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      summary: 'Coordinator recovery snapshot hydration',
      settle: (item) => {
        walkedRecoveryItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'raw coordinator job hydrated',
        };
      },
    });
    const providerOperationFenceSnapshot = providerOperationStartupOwnership.snapshot();
    const sagaOwnedJobIds = new Set([
      ...providerOperationFenceSnapshot.records.map((record) => record.operation.jobId),
      ...providerOperationFenceSnapshot.unreadable.flatMap((attribution) =>
        attribution.jobs.kind === 'known'
          ? attribution.jobs.values.filter((jobId) => {
              const status = progressStore.readStatus(jobId);
              return status === null || !isTerminalPhase(status.phase);
            })
          : [],
      ),
    ]);
    const recoveryItems = walkedRecoveryItems.filter((item) => !sagaOwnedJobIds.has(item.jobId));
    const snapshot = buildRecoverySnapshot(recoveryItems, runtime.process);
    const plan = planRecovery(snapshot);
    const itemsByJobId = new Map(recoveryItems.map((item) => [item.jobId, item]));
    const itemsBySessionId = new Map(
      recoveryItems.flatMap((item) =>
        item.claimedSession === null ? [] : [[item.claimedSession.sessionId, item] as const],
      ),
    );

    const planActionOptions = {
      itemsByJobId,
      itemsBySessionId,
      recoveryRegistry,
      queuedRecoverable,
      runningRecoverable,
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
    } as const;

    for (const action of plan.register) {
      await applyPlanAction(action, planActionOptions);
    }
    for (const action of plan.cleanup) {
      await applyPlanAction(action, planActionOptions);
    }

    if (queuedRecoverable.length > 0 || runningRecoverable.length > 0) {
      await recoveryAdoption.run({
        queuedJobs: queuedRecoverable,
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit: ctx.coordinatorCommit,
        interruptedAppServerReason,
        abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
      });
    }
    const postReconciliationSnapshot = providerOperationStartupOwnership.snapshot();
    const postReconciliationOwnership = providerOperationStartupOwnership.hydrate(postReconciliationSnapshot);
    const startupLocalRecoveryOperations = new Set(
      postReconciliationOwnership.records.flatMap((ownership) =>
        ownership.phase === 'local-recovery-pending' &&
        ownership.bindingDisposition.kind === 'not-required' &&
        ownership.bindingDisposition.owner === 'generic-job-recovery'
          ? [providerOperationStartupIdentityKey(ownership.operation)]
          : [],
      ),
    );
    const localRecoveryRecords = postReconciliationSnapshot.records.filter(
      (record): record is Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }> =>
        record.phase === 'local-recovery-pending' &&
        startupLocalRecoveryOperations.has(providerOperationStartupIdentityKey(record.operation)),
    );
    const providerOperationHolds: ProviderOperationStartupHold[] =
      postReconciliationOwnership.completion.kind === 'held' ? [...postReconciliationOwnership.completion.holds] : [];
    for (const record of localRecoveryRecords) {
      try {
        await recoverProviderOperationJob(record, signal);
      } catch (error: unknown) {
        const reason =
          `Provider operation exact-job recovery for ${record.operation.jobId} failed: ` + formatError(error);
        const ownership = providerOperationStartupOwnership.holdRecoveryFailure(record, reason);
        if (ownership.bindingDisposition.kind === 'refused') {
          providerOperationHolds.push({
            kind: 'operation',
            jobId: ownership.operation.jobId,
            operationId: ownership.operation.operationId,
            reason: ownership.bindingDisposition.reason,
            remedy: ownership.bindingDisposition.remedy,
          });
        }
        log(`${reason}\n`);
      }
    }
    signal.throwIfAborted();
    resetRecoveryState();
    const durableHoldRemains = listDurableCliContainmentStatuses(progressStore.getDb()).some((statusRead) => {
      if (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') return false;
      const jobId = statusRead.kind === 'valid' ? statusRead.status.jobId : statusRead.jobId;
      return recoveryRegistry.has(jobId);
    });
    if (providerOperationHolds.length > 0 || durableHoldRemains) {
      const heldSubjects = providerOperationHolds.map((hold) => {
        const subject =
          hold.kind === 'operation' ? `operation=${hold.operationId}` : `record=${JSON.stringify(hold.recordKey)}`;
        return `provider operation job=${hold.jobId} ${subject} reason=${JSON.stringify(hold.reason)}`;
      });
      if (durableHoldRemains) {
        heldSubjects.push('durable containment awaiting repair or operator abandonment');
      }
      log(`Recovery reconciliation remains held:\n${heldSubjects.join('\n')}\nLaunch fence lifted.\n`);
      return {
        kind: 'held',
        progressStore,
        providerOperationHolds,
        durableContainmentHeld: durableHoldRemains,
      };
    }
    log('Recovery adoption complete. Launch fence lifted.\n');
    return { kind: 'complete', progressStore };
  }

  return { run: runStartupRecovery };
}
