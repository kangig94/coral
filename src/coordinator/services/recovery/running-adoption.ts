import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage, formatError } from '../../../infra/error-format.js';
import { ProcessContainmentError, type RecordedContainmentObservation } from '../../../infra/process-containment.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import { isAppServerRuntime } from '../../../jobs/records.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { RecoveryAbortDisposition, RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import { readDurableCliContainmentStatus, writeDurableCliContainmentStatus } from '../../../jobs/runtime-meta-store.js';
import type { RecoveryDisposition } from '../../../recovery/containment.js';
import {
  COORDINATOR_CLAIM_RELEASE_OBLIGATION,
  COORDINATOR_NOT_APPLICABLE_FACTS,
  COORDINATOR_TERMINAL_OBLIGATION,
  durableOwnershipEvidenceHoldReason,
  durableOwnershipStatusEvidence,
  finalizeDeadAdoptedJob,
  type RunningRecoverableJob,
} from './actions.js';
import type { reapDurableCliProcess } from './actions.js';
import type { CoordinatorRecoveryItem } from './snapshot.js';
import type { CoordinatorRecoveryControls, CoordinatorWalkOptions, createRecoveryWalk } from './walk.js';

const RECOVERY_POLL_MS = 500;
const UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD = 10;

export type RunningRecoveryAdoptionContext = Readonly<{
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
  abandonHeldJob(jobId: string): RecoveryAbortDisposition;
}>;

type RunningRecoveryAdoptionState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  unansweredAdoptionProbes: Map<string, number>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  teardownRequested: boolean;
};

export function createRunningRecoveryAdoption(
  deps: Readonly<{
    state: RunningRecoveryAdoptionState;
    progressStore: JobStore;
    runtime: Runtime;
    getRecoveryService(ctx: InvocationContext): RecoveryCapableService;
    createInvocationContext(projectRoot: string): InvocationContext;
    log(message: string): void;
    clearRecoveryPoller(jobId: string): void;
    startTrackedFinalization(
      jobId: string,
      parentSignal: AbortSignal,
      run: (fence: { signal: AbortSignal; onCommitStart(): void }) => Promise<void>,
    ): Promise<void>;
    observeDurableRecoveryContainment(
      jobId: string,
      runtimeRecord: Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>,
    ): Readonly<{
      evidence: DurableCliPreReadyOwnershipEvidence;
      observation: RecordedContainmentObservation;
    }>;
    runHeldRecoveryReap(
      jobId: string,
      record: Parameters<typeof reapDurableCliProcess>[1],
      parentSignal: AbortSignal,
    ): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>>;
    deleteCoordinatorRecoveryQuarantine(jobId: string): boolean;
    runCoordinatorWalk(options: CoordinatorWalkOptions): Promise<unknown>;
    settleUnexpectedRecoveryFailure: ReturnType<typeof createRecoveryWalk>['settleUnexpectedRecoveryFailure'];
    settleFault: ReturnType<typeof createRecoveryWalk>['settleFault'];
    takeAdoptedJobCleanup(jobId: string): (() => void) | null;
    maybeReleaseRecoveryRegistry(): void;
  }>,
) {
  const {
    state,
    progressStore,
    runtime,
    getRecoveryService,
    createInvocationContext,
    log,
    clearRecoveryPoller,
    startTrackedFinalization,
    observeDurableRecoveryContainment,
    runHeldRecoveryReap,
    deleteCoordinatorRecoveryQuarantine,
    runCoordinatorWalk,
    settleUnexpectedRecoveryFailure,
    settleFault,
    takeAdoptedJobCleanup,
    maybeReleaseRecoveryRegistry,
  } = deps;

  return async function runRunningRecovery(
    { jobId, authority, runtimeRecord }: RunningRecoverableJob,
    { signal, coordinatorCommit, interruptedAppServerReason, abandonHeldJob }: RunningRecoveryAdoptionContext,
    direct?: Readonly<{ item: CoordinatorRecoveryItem; controls: CoordinatorRecoveryControls }>,
  ): Promise<RecoveryDisposition | void> {
    const { launchRecord, boundProvider } = authority;
    const settleRunningRecovery = async (
      item: CoordinatorRecoveryItem,
      controls: CoordinatorRecoveryControls,
    ): Promise<RecoveryDisposition> => {
      controls.setProcessLocalCleanup(() => {
        state.recoveryRegistry?.remove(jobId);
        state.recoveryRegistry?.clearCancelled(jobId);
      });
      const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
      const pendingAbort = state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement;
      if (pendingAbort !== undefined) {
        void (await pendingAbort.catch(() => undefined));
        signal.throwIfAborted();
      }
      if (isAppServerRuntime(runtimeRecord)) {
        const abortDisposition = state.recoveryRegistry?.getAbortDisposition(jobId);
        const userCancelled = abortDisposition?.kind === 'finalization-pending';
        if (abortDisposition !== undefined && !userCancelled) {
          controls.clearProcessLocalCleanup();
          const detail = `${abortDisposition.reason}. ${abortDisposition.nextStep}`;
          controls.report(`Held recovered app-server abort for ${jobId}: ${abortDisposition.reason}\n`);
          return { kind: 'quarantine', detail };
        }
        if (!userCancelled) {
          state.recoveryRegistry?.setAbortHandler(jobId, () => ({
            kind: 'refused',
            reason: 'startup recovery already owns app-server finalization',
            nextStep:
              `Wait for startup recovery to finish, then run coral-cli jobs detail ${jobId} before retrying ` +
              'an abort.',
          }));
        }
        signal.throwIfAborted();
        try {
          await startTrackedFinalization(jobId, signal, (fence) =>
            service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
              reason: userCancelled ? 'user_abort' : interruptedAppServerReason,
              ...fence,
            }),
          );
        } catch (error: unknown) {
          if (userCancelled) {
            controls.clearProcessLocalCleanup();
            const detail = `User-abort terminal finalization failed after provider acknowledgment: ${errorMessage(error)}`;
            controls.report(`Held acknowledged recovered app-server abort for ${jobId}: ${errorMessage(error)}\n`);
            return { kind: 'quarantine', detail };
          }
          // An unconfirmed detached carrier must remain nonterminal.
          if (error instanceof ProcessContainmentError) {
            controls.report(
              `Carrier reap unconfirmed for interrupted app-server job: ${jobId}: ${errorMessage(error)}\n`,
            );
            return { kind: 'quarantine', detail: error.message };
          }
          throw error;
        }
        signal.throwIfAborted();
        controls.report(
          userCancelled
            ? `Finalized user-aborted recovered app-server job: ${jobId}\n`
            : `Recovered interrupted app-server job: ${jobId}\n`,
        );
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: [
            { obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done', authorityRef: `job:${jobId}:terminal` },
            {
              obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
              outcome: item.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
              ...(item.claimedSession?.activeJobId === jobId
                ? { authorityRef: `session:${item.claimedSession.sessionId}:claim:${jobId}` }
                : {}),
            },
          ],
          detail: userCancelled ? 'user-aborted app-server job finalized' : 'interrupted app-server job finalized',
        };
      }
      if (!isDurableCliRuntime(runtimeRecord)) {
        const facts = settleFault(item, jobId, { kind: 'wrapper_lost' }, coordinatorCommit);
        controls.report(`Skipped adopting unsupported runtime for job: ${jobId}\n`);
        return { kind: 'advanced', outcome: 'settled', facts, detail: 'unsupported runtime finalized' };
      }

      const recovery = boundProvider.recovery;
      let adoptedRuntimeRecord = runtimeRecord;
      const drainRecoveredProgress = (): void => {
        if (!recovery?.extractProgress) return;
        try {
          const { messages, newOffset } = recovery.extractProgress({
            stdoutPath: adoptedRuntimeRecord.stdoutPath,
            fromOffset: adoptedRuntimeRecord.tailWatermark ?? 0,
          });
          if (newOffset !== (adoptedRuntimeRecord.tailWatermark ?? 0)) {
            adoptedRuntimeRecord = { ...adoptedRuntimeRecord, tailWatermark: newOffset };
            progressStore.appendRuntimeStarted(jobId, adoptedRuntimeRecord);
          }
          for (const message of messages) {
            progressStore.appendProgress(jobId, launchRecord.sessionId, message);
          }
        } catch (error: unknown) {
          controls.report(`Failed to tail recovered progress for job ${jobId}: ${formatError(error)}\n`);
        }
      };

      const persistedContainment = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
      if (persistedContainment.kind === 'corrupt') {
        const reason = 'The durable containment status is corrupt.';
        progressStore.appendProgress(
          jobId,
          launchRecord.sessionId,
          `${reason} Repair or remove the status row and retry the coordinator-job-recovery quarantine, or run ` +
            `coral-cli abort jobs ${jobId} to abandon job ownership without proving process absence or sending a signal.`,
        );
        state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
        controls.clearProcessLocalCleanup();
        controls.report(`Held durable recovery job with corrupt containment status: ${jobId}\n`);
        return {
          kind: 'quarantine',
          detail:
            `${reason} Repair or remove the status row and retry this quarantine, or run coral-cli abort jobs ` +
            `${jobId} to abandon job ownership without proving process absence or sending a signal.`,
        };
      }

      const containment = observeDurableRecoveryContainment(jobId, runtimeRecord);
      let operatorAbandoned =
        persistedContainment.kind === 'valid' && persistedContainment.status.disposition.kind === 'operator-abandoned';
      let absenceConfirmed = containment.observation.kind === 'absent';
      if (
        persistedContainment.kind === 'valid' &&
        persistedContainment.status.disposition.kind === 'held' &&
        !absenceConfirmed
      ) {
        const retryIntervalMs = persistedContainment.status.disposition.retryIntervalMs;
        const cleanup =
          containment.evidence.kind === 'current' || containment.evidence.kind === 'provisional'
            ? await runHeldRecoveryReap(jobId, containment.evidence.record, signal)
            : { kind: 'held' as const, reason: durableOwnershipEvidenceHoldReason(containment.evidence) };
        if (cleanup.kind === 'superseded') {
          signal.throwIfAborted();
          return {
            kind: 'deferred',
            authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
            detail: 'durable containment reap ownership transferred',
          };
        }
        const statusAfterCleanup = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
        operatorAbandoned =
          statusAfterCleanup.kind === 'valid' && statusAfterCleanup.status.disposition.kind === 'operator-abandoned';
        if (cleanup.kind === 'absence-confirmed') {
          absenceConfirmed = true;
        } else if (!operatorAbandoned) {
          writeDurableCliContainmentStatus(progressStore.getDb(), {
            jobId,
            evidence: durableOwnershipStatusEvidence(containment.evidence),
            disposition: {
              kind: 'held',
              reason: cleanup.reason,
              retryIntervalMs,
              abandonment: 'abort-job',
            },
          });
          if (!state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId))) {
            throw new Error('Durable containment hold was not accepted by the recovery registry.');
          }
          if (!state.recoveryPollIntervals.has(jobId)) {
            let retryInFlight = false;
            const retryHeldCleanup = async (): Promise<void> => {
              if (state.teardownRequested) return;
              const currentStatus = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
              if (currentStatus.kind === 'valid' && currentStatus.status.disposition.kind === 'operator-abandoned') {
                clearRecoveryPoller(jobId);
                return;
              }

              const currentContainment = observeDurableRecoveryContainment(jobId, runtimeRecord);
              const retryCleanup =
                currentContainment.observation.kind === 'absent'
                  ? ({ kind: 'absence-confirmed' } as const)
                  : currentContainment.evidence.kind === 'current' || currentContainment.evidence.kind === 'provisional'
                    ? await runHeldRecoveryReap(jobId, currentContainment.evidence.record, signal)
                    : {
                        kind: 'held' as const,
                        reason: durableOwnershipEvidenceHoldReason(currentContainment.evidence),
                      };
              if (retryCleanup.kind === 'superseded') return;
              const statusAfterCleanup = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
              if (
                statusAfterCleanup.kind === 'valid' &&
                statusAfterCleanup.status.disposition.kind === 'operator-abandoned'
              ) {
                clearRecoveryPoller(jobId);
                return;
              }
              if (retryCleanup.kind === 'held') {
                writeDurableCliContainmentStatus(progressStore.getDb(), {
                  jobId,
                  evidence: durableOwnershipStatusEvidence(currentContainment.evidence),
                  disposition: {
                    kind: 'held',
                    reason: retryCleanup.reason,
                    retryIntervalMs,
                    abandonment: 'abort-job',
                  },
                });
                if (
                  currentStatus.kind !== 'valid' ||
                  currentStatus.status.disposition.kind !== 'held' ||
                  currentStatus.status.disposition.reason !== retryCleanup.reason
                ) {
                  progressStore.appendProgress(
                    jobId,
                    launchRecord.sessionId,
                    `Durable recovery cleanup remains held (${retryCleanup.reason}).`,
                  );
                }
                return;
              }

              clearRecoveryPoller(jobId);
              if (!deleteCoordinatorRecoveryQuarantine(jobId)) return;
              await runCoordinatorWalk({
                subjectKey: jobId,
                signal,
                coordinatorCommit,
                summary: `Held durable recovery finalization for ${jobId}`,
                settle: settleRunningRecovery,
                settleFailure: (item, error, controls) =>
                  settleUnexpectedRecoveryFailure(
                    item,
                    jobId,
                    'Held durable recovery finalization failed',
                    error,
                    coordinatorCommit,
                    controls.report,
                  ),
              });
            };
            const pollInterval = runtime.time.setInterval(() => {
              if (retryInFlight) return;
              retryInFlight = true;
              void retryHeldCleanup()
                .catch((error: unknown) => {
                  log(`Held durable recovery retry failed for ${jobId}: ${formatError(error)}\n`);
                })
                .finally(() => {
                  retryInFlight = false;
                });
            }, retryIntervalMs);
            pollInterval.unref?.();
            state.recoveryPollIntervals.set(jobId, pollInterval);
          }
          if (!state.recoveryPollIntervals.has(jobId)) {
            throw new Error('Durable containment retry was not accepted by the recovery coordinator.');
          }
          controls.clearProcessLocalCleanup();
          progressStore.appendProgress(
            jobId,
            launchRecord.sessionId,
            `Durable recovery cleanup remains held (${cleanup.reason}). Identity-safe reaping continues every ` +
              `${retryIntervalMs}ms until absence is confirmed, or run coral-cli abort jobs ${jobId} to abandon ` +
              'job ownership without proving process absence or sending another signal.',
          );
          controls.report(`Held durable recovery cleanup: ${jobId}: ${cleanup.reason}\n`);
          return {
            kind: 'deferred',
            continuation: { kind: 'durable-containment-reap', key: jobId },
            detail:
              `${cleanup.reason}. Identity-safe reaping continues every ${retryIntervalMs}ms until absence is ` +
              `confirmed, or run coral-cli abort jobs ${jobId} to abandon job ownership without proving process ` +
              'absence or sending another signal.',
          };
        }
      }

      if (absenceConfirmed || operatorAbandoned) {
        if (operatorAbandoned) state.cancelledRecoveryJobIds.add(jobId);
        drainRecoveredProgress();
        await startTrackedFinalization(jobId, signal, (fence) =>
          finalizeDeadAdoptedJob({
            jobId,
            runtimeRecord: adoptedRuntimeRecord,
            service,
            authority,
            progressStore,
            cancelledJobIds: state.cancelledRecoveryJobIds,
            fence,
          }),
        );
        controls.setProcessLocalCleanup(() => {
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
        });
        controls.report(
          operatorAbandoned
            ? `Finalized operator-abandoned durable recovery job: ${jobId}\n`
            : `Finalized dead durable recovery job: ${jobId}\n`,
        );
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: [
            { obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done', authorityRef: `job:${jobId}:terminal` },
            {
              obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
              outcome: item.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
              ...(item.claimedSession?.activeJobId === jobId
                ? { authorityRef: `session:${item.claimedSession.sessionId}:claim:${jobId}` }
                : {}),
            },
          ],
          detail: operatorAbandoned
            ? 'operator-abandoned durable job finalized without process absence proof'
            : 'dead durable job finalized',
        };
      }

      if (containment.observation.kind === 'unobservable') {
        const reason = containment.observation.reason;
        writeDurableCliContainmentStatus(progressStore.getDb(), {
          jobId,
          evidence: durableOwnershipStatusEvidence(containment.evidence),
          disposition: {
            kind: 'held',
            reason,
            retryIntervalMs: RECOVERY_POLL_MS,
            abandonment: 'abort-job',
          },
        });
        progressStore.appendProgress(
          jobId,
          launchRecord.sessionId,
          `Durable recovery containment pid=${runtimeRecord.pid} is held (${reason}). ` +
            `Repair the recorded containment and retry the coordinator-job-recovery quarantine, or run ` +
            `coral-cli abort jobs ${jobId} to abandon job ownership without proving process absence or sending a signal.`,
        );
        state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
        controls.clearProcessLocalCleanup();
        controls.report(`Held durable recovery job: ${jobId}: ${reason}\n`);
        return {
          kind: 'quarantine',
          detail:
            `${reason}. Repair the recorded containment and retry this quarantine, or run coral-cli abort jobs ` +
            `${jobId} to abandon job ownership without proving process absence or sending a signal.`,
        };
      }

      signal.throwIfAborted();
      const adoption = await service.adoptRunningJob(authority, runtimeRecord);
      if (!adoption.adopted) {
        controls.report(`Rejected running recovery before adoption: ${jobId}\n`);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'running adoption rejected',
        };
      }
      if (signal.aborted) {
        adoption.cleanup();
        throw signal.reason;
      }

      let cleaned = false;
      const cleanupOnce = (): void => {
        if (cleaned) return;
        cleaned = true;
        adoption.cleanup();
      };
      state.adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });
      state.adoptedRunningJobCleanups.set(jobId, cleanupOnce);

      const pollInterval = runtime.time.setInterval(() => {
        drainRecoveredProgress();
        const observation = observeDurableRecoveryContainment(jobId, runtimeRecord).observation;
        if (observation.kind === 'unobservable') {
          const unanswered = (state.unansweredAdoptionProbes.get(jobId) ?? 0) + 1;
          state.unansweredAdoptionProbes.set(jobId, unanswered);
          if (unanswered === UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD) {
            backendLog.warn(
              `Containment of adopted job ${jobId} (pid ${runtimeRecord.pid}) has been unobservable for ` +
                `${unanswered} checks; it stays adopted until a probe answers.`,
            );
          }
          return;
        }
        state.unansweredAdoptionProbes.delete(jobId);
        if (observation.kind === 'alive') return;
        if (state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement !== undefined) return;

        clearRecoveryPoller(jobId);
        state.adoptedRunningPids.delete(jobId);
        state.unansweredAdoptionProbes.delete(jobId);
        const retainedCleanup = takeAdoptedJobCleanup(jobId);
        if (state.teardownRequested) {
          retainedCleanup?.();
          return;
        }

        drainRecoveredProgress();
        const finalization = startTrackedFinalization(jobId, signal, async (fence) => {
          await runCoordinatorWalk({
            subjectKey: jobId,
            signal,
            coordinatorCommit,
            summary: `Adopted durable recovery finalization for ${jobId}`,
            settle: async (finalItem, finalControls) => {
              finalControls.setProcessLocalCleanup(() => {
                state.recoveryRegistry?.remove(jobId);
                state.recoveryRegistry?.clearCancelled(jobId);
                retainedCleanup?.();
                maybeReleaseRecoveryRegistry();
              });
              await finalizeDeadAdoptedJob({
                jobId,
                runtimeRecord: adoptedRuntimeRecord,
                service,
                authority,
                progressStore,
                cancelledJobIds: state.cancelledRecoveryJobIds,
                fence,
              });
              return {
                kind: 'advanced',
                outcome: 'settled',
                facts: [
                  {
                    obligation: COORDINATOR_TERMINAL_OBLIGATION,
                    outcome: 'done',
                    authorityRef: `job:${jobId}:terminal`,
                  },
                  {
                    obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
                    outcome: finalItem.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
                    ...(finalItem.claimedSession?.activeJobId === jobId
                      ? { authorityRef: `session:${finalItem.claimedSession.sessionId}:claim:${jobId}` }
                      : {}),
                  },
                ],
                detail: 'adopted durable job finalized',
              };
            },
            settleFailure: (item, error, controls) =>
              settleUnexpectedRecoveryFailure(
                item,
                jobId,
                'Adopted durable recovery finalization failed',
                error,
                coordinatorCommit,
                controls.report,
              ),
          });
        });
        void finalization.catch((error: unknown) => {
          try {
            log(`Durable finalization cleanup failed for ${jobId}: ${formatError(error)}\n`);
          } catch {
            // Reporting remains best-effort after the async cleanup frame.
          }
          throw error;
        });
      }, RECOVERY_POLL_MS);
      pollInterval.unref?.();
      state.recoveryPollIntervals.set(jobId, pollInterval);
      controls.clearProcessLocalCleanup();
      controls.report(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts: COORDINATOR_NOT_APPLICABLE_FACTS,
        detail: 'running job adopted',
      };
    };
    if (direct?.item.jobId === jobId) {
      return settleRunningRecovery(direct.item, direct.controls);
    }
    await runCoordinatorWalk({
      subjectKey: jobId,
      signal,
      coordinatorCommit,
      summary: `Running recovery adoption for ${jobId}`,
      settle: settleRunningRecovery,
      settleFailure: (item, error, controls) =>
        settleUnexpectedRecoveryFailure(
          item,
          jobId,
          'Running recovery adoption failed',
          error,
          coordinatorCommit,
          controls.report,
        ),
    });
  };
}
