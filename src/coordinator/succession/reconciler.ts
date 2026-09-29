import type { Runtime } from '../../runtime/ports.js';
import {
  readUpgradeIntent,
  retryUpgradeIntentCas,
  type UpgradeIntent,
  type UpgradeIntentCasStep,
  type UpgradeIntentChange,
} from '../../infra/upgrade-intent.js';
import type { SuccessionPreparation, SuccessionReady } from './protocol.js';
import type { UnservedMintDiscard } from '../../store/epoch.js';
import type { SuccessionOwner, SuccessionOwnerId } from './obligations.js';
import { createSuccessionIntentAdoption } from './reconciler/adoption.js';
import { createSuccessionReconcilerState } from './reconciler/state.js';
import { createSuccessionSettlement } from './reconciler/settlement.js';
import { createSuccessionReconciliationPass } from './reconciler/pass.js';
import { prepareObservedIntent, readPreparation } from './reconciler/preparation.js';
import { createSuccessionReconciliationScheduler } from './reconciliation-scheduler.js';
import { createIntentTransitionRequests, decisionOf } from './intent-transitions.js';

type IncumbentIdentity = UpgradeIntent['incumbent'];
type Target = UpgradeIntent['target'];

export type SuccessionReconcilerOptions = Readonly<{
  runtime: Pick<Runtime, 'time' | 'ids' | 'storage'>;
  runDir: string;
  /** Every intent write of this process’s identity must use one source so a late incarnation cannot appear foreign. */
  incumbent: () => IncumbentIdentity;
  runningBuildSetId?: string;
  owners: readonly SuccessionOwner[];
  requiredOwners?: readonly SuccessionOwnerId[];
  liveJobIds?: () => readonly string[];
  storeFormatFingerprint?: string;
  epochKey: () => string | null;
  admissionRevision: () => number;
  newAttemptId?: () => string;
  observeServing?: (attemptId: string) => Readonly<{
    epochKey: string;
    controlGeneration: number;
    successorInstanceId: string;
    recordedAt: string;
  }> | null;
  retirementServing?: (attemptId: string, incumbentEpochKey: string) => boolean;
  onIntentChanged?: () => void;
  onReconcileError?: (error: unknown) => void;
  commitAvailable?: boolean;
  subscribeObligationChanges?: (notify: () => void) => () => void;
  launchPrepared?: (intent: UpgradeIntent, preparation: SuccessionPreparation) => Promise<SuccessionLaunch>;
  discardUnservedMint?: (incumbentEpochKey: string, attemptId: string) => UnservedMintDiscard;
  retryIntervalMs?: number;
}>;

/**
 * `clear-owed` must persist until the write clearing the attempt lands; otherwise the intent claims an
 * unsupervised commit.
 */
export type SuccessionLaunchSettlement =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'clear-owed'; attemptId: string; clear: (intent: UpgradeIntent) => UpgradeIntent }>;

/** A launched attempt belongs to its commit until `settled`; nothing may prepare over or abort it before then. */
export type SuccessionLaunch = Readonly<{ settled: Promise<SuccessionLaunchSettlement> }>;

export type SuccessionDecision =
  | Readonly<{ kind: 'registered'; intent: UpgradeIntent }>
  | Readonly<{ kind: 'prepared'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'ready'; preparation: SuccessionPreparation }>
  | Readonly<{ kind: 'committed'; receipt: NonNullable<UpgradeIntent['completionReceipt']> }>
  | Readonly<{ kind: 'deferred'; reason: string; blockers?: readonly { owner: string; reason: string }[] }>
  | Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'stale'; reason: string; cause: 'target-change' | 'obligation-change' }>
  | Readonly<{ kind: 'aborted' }>;

export type SuccessionStatus =
  | Readonly<{ kind: 'readable'; intent: UpgradeIntent; preparation: SuccessionPreparation | null }>
  | Readonly<{ kind: 'absent' | 'unreadable' | 'corrupt' | 'unsupported' }>;

export type SuccessionReconciler = Readonly<{
  incumbent: () => IncumbentIdentity;
  request: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
  repairSupervision: (input: { requestId: string; target: Target }) => Promise<SuccessionDecision>;
  prepare: (requestId: string) => Promise<SuccessionDecision>;
  reportReady: (report: SuccessionReady) => Promise<SuccessionDecision>;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  /** `prepared` only while every owner the target cannot accept still completes for the prepared attempt. */
  recertify: (attemptId: string) => Promise<SuccessionDecision>;
  abort: (attemptId: string) => Promise<SuccessionDecision>;
  status: (requestId?: string) => SuccessionStatus;
  reconcile: () => Promise<SuccessionDecision>;
  notifyObligationChange: () => void;
  dispose: () => void;
}>;

export function createSuccessionReconciler(options: SuccessionReconcilerOptions): SuccessionReconciler {
  const newAttemptId = options.newAttemptId ?? (() => options.runtime.ids.uuid());
  const state = createSuccessionReconcilerState();
  const scheduler = createSuccessionReconciliationScheduler({
    time: options.runtime.time,
    retryIntervalMs: options.retryIntervalMs ?? 30_000,
    subscribe: options.subscribeObligationChanges,
    runPass: () => reconcilePending(),
    onError: options.onReconcileError,
  });
  const { reconcile, notifyObligationChange } = scheduler;
  const writeThen = (
    intent: UpgradeIntent,
    change: UpgradeIntentChange,
    decision: SuccessionDecision,
  ): UpgradeIntentCasStep<SuccessionDecision> => ({
    kind: 'write',
    expectedRevision: intent.revision,
    change,
    settle: () => {
      options.onIntentChanged?.();
      return decision;
    },
  });

  const { adopt, adoptNextTarget, close } = createSuccessionIntentAdoption({
    options,
    notifyObligationChange,
    writeThen,
  });

  function attemptFor(intent: UpgradeIntent): string {
    if (state.pendingAttempt?.requestId !== intent.requestId || state.pendingAttempt.revision !== intent.revision) {
      state.pendingAttempt = { requestId: intent.requestId, revision: intent.revision, attemptId: newAttemptId() };
    }
    return state.pendingAttempt.attemptId;
  }

  const { reportReady, abort, commit, recertify } = createSuccessionSettlement({
    options,
    state,
    status,
    notifyObligationChange,
    writeThen,
  });

  const reconcilePending = createSuccessionReconciliationPass({
    options,
    state,
    status,
    notifyObligationChange,
    adopt,
    adoptNextTarget,
    close,
    prepare,
    commit,
    abort,
  });

  function dispose(): void {
    if (state.disposed) return;
    state.disposed = true;
    scheduler.dispose();
    options.runtime.time.clearTimeout(state.backoffWake);
  }

  const { request, repairSupervision } = createIntentTransitionRequests(
    options,
    notifyObligationChange,
    () => state.launchedAttempt,
  );

  async function prepare(requestId: string): Promise<SuccessionDecision> {
    const heldAttempts = new Set<string>();
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
      prepareObservedIntent({
        options,
        requestId,
        heldAttempts,
        observed,
        commit,
        getLaunchedAttempt: () => state.launchedAttempt,
        writeThen,
        attemptFor,
        preparingAttempts: state.preparingAttempts,
        clearPendingAttempt: () => {
          state.pendingAttempt = null;
        },
      }),
    ).finally(() => {
      for (const attemptId of heldAttempts) {
        const count = state.preparingAttempts.get(attemptId);
        if (count === 1) state.preparingAttempts.delete(attemptId);
        else if (count !== undefined) state.preparingAttempts.set(attemptId, count - 1);
      }
    });
    return decisionOf(outcome, 'refused');
  }

  function status(requestId?: string): SuccessionStatus {
    const observed = readUpgradeIntent(options.runDir);
    if (observed.kind !== 'readable') return { kind: observed.kind };
    if (requestId !== undefined && observed.intent.requestId !== requestId) return { kind: 'absent' as const };
    return { kind: 'readable' as const, intent: observed.intent, preparation: readPreparation(observed.intent) };
  }

  return {
    incumbent: options.incumbent,
    request,
    repairSupervision,
    prepare,
    reportReady,
    commit,
    recertify,
    abort,
    status,
    reconcile,
    notifyObligationChange,
    dispose,
  };
}
