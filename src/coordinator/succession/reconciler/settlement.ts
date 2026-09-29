import { join } from 'node:path';

import {
  retryUpgradeIntentCas,
  type UpgradeIntent,
  type UpgradeIntentChange,
  type UpgradeIntentCasStep,
} from '../../../infra/upgrade-intent.js';
import { failedAttemptRetry, recoveryRetryOf } from '../attempt-retry.js';
import { recertifyUntransferableOwners } from '../obligations.js';
import {
  readSuccessionCapabilities,
  successionTargetKey,
  type SuccessionPreparation,
  type SuccessionReady,
} from '../protocol.js';
import {
  committing,
  decisionOf,
  holdsRecovery,
  LAUNCH_IN_FLIGHT,
  RECOVERY_HOLDS_INTENT,
  settle,
} from '../intent-transitions.js';
import type { SuccessionDecision, SuccessionReconcilerOptions, SuccessionStatus } from './index.js';
import { currentPreparation, emptyCapabilities, staleCause } from './preparation.js';
import type { SuccessionReconcilerState } from './state.js';

type SettlementContext = Readonly<{
  options: SuccessionReconcilerOptions;
  state: SuccessionReconcilerState;
  status: (requestId?: string) => SuccessionStatus;
  notifyObligationChange: () => void;
  writeThen: (
    intent: UpgradeIntent,
    change: UpgradeIntentChange,
    decision: SuccessionDecision,
  ) => UpgradeIntentCasStep<SuccessionDecision>;
}>;

export function createSuccessionSettlement(context: SettlementContext): Readonly<{
  reportReady: (report: SuccessionReady) => Promise<SuccessionDecision>;
  abort: (attemptId: string) => Promise<SuccessionDecision>;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  recertify: (attemptId: string) => Promise<SuccessionDecision>;
}> {
  return {
    reportReady: (report) => reportReady(context, report),
    abort: (attemptId) => abortAttempt(context, attemptId),
    commit: (attemptId) => commitAttempt(context, attemptId),
    recertify: (attemptId) => recertify(context, attemptId),
  };
}

async function reportReady(context: SettlementContext, report: SuccessionReady): Promise<SuccessionDecision> {
  const { options, status, notifyObligationChange } = context;
  const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, () => {
    const observed = status();
    if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: 'upgrade intent unavailable' });
    const { intent, preparation } = observed;
    if (preparation === null || preparation.attemptId !== report.attemptId) {
      return settle({ kind: 'refused', reason: 'attempt is not prepared' });
    }
    if (!currentPreparation(intent, preparation, options)) {
      return settle({
        kind: 'stale',
        reason: 'preparation is stale',
        cause: staleCause(intent, preparation, options),
      });
    }
    const declaration = readSuccessionCapabilities(
      options.runtime,
      join(intent.target.pluginRootLabel, 'bridge'),
      intent.target.build,
    );
    if (declaration.kind !== 'declared' || !declaration.capabilities.protocols.includes('commit')) {
      return settle({ kind: 'deferred', reason: 'target cannot commit succession' });
    }
    if (preparation.stage === 'ready' && JSON.stringify(preparation.ready) === JSON.stringify(report)) {
      return settle({ kind: 'ready', preparation });
    }
    if (
      preparation.stage !== 'prepared' ||
      preparation.ready !== null ||
      report.successorPid === options.incumbent().pid ||
      report.targetKey !== preparation.targetKey ||
      report.epochKey !== preparation.epochKey ||
      report.admissionRevision !== preparation.admissionRevision ||
      JSON.stringify([...report.receiptIds].sort()) !==
        JSON.stringify(preparation.receipts.map((receipt) => receipt.receiptId).sort())
    ) {
      return settle({ kind: 'refused', reason: 'successor ready report does not match the prepared attempt' });
    }
    const next: SuccessionPreparation = { ...preparation, stage: 'ready', ready: report };
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: { ...intent, successionPreparation: next },
      settle: () => {
        options.onIntentChanged?.();
        notifyObligationChange();
        return { kind: 'ready', preparation: next };
      },
    };
  });
  return decisionOf(outcome, 'refused');
}

async function abortAttempt(context: SettlementContext, attemptId: string): Promise<SuccessionDecision> {
  const { options, state, writeThen } = context;
  const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, async (observed) => {
    if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
    const intent = observed.intent;
    if (intent.attemptId !== attemptId) return settle({ kind: 'refused', reason: 'attempt is not current' });
    if (intent.disposition === 'completed') return settle({ kind: 'refused', reason: 'attempt already serves' });
    if ((options.observeServing?.(attemptId) ?? null) !== null) return settle(await commitAttempt(context, attemptId));
    if (committing(intent)) return settle({ kind: 'refused', reason: 'attempt is committing' });
    if (attemptId === state.launchedAttempt) return settle({ kind: 'refused', reason: LAUNCH_IN_FLIGHT });
    if (holdsRecovery(intent)) return settle({ kind: 'refused', reason: RECOVERY_HOLDS_INTENT });
    return writeThen(
      intent,
      {
        ...intent,
        disposition: 'pending',
        attemptId: null,
        attemptOwner: null,
        attemptDeadline: null,
        blockers: [],
        retryCondition: null,
        successionPreparation: null,
      },
      { kind: 'aborted' },
    );
  });
  return decisionOf(outcome, 'refused');
}

async function commitAttempt(context: SettlementContext, attemptId: string): Promise<SuccessionDecision> {
  const { options, status, notifyObligationChange, writeThen } = context;
  let writeRefusal: 'refused' | 'deferred' = 'refused';
  const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, () => {
    const observed = status();
    if (observed.kind !== 'readable') return settle({ kind: 'refused', reason: 'upgrade intent unavailable' });
    if (observed.intent.disposition === 'completed' && observed.intent.completionReceipt?.attemptId === attemptId) {
      const receipt = observed.intent.completionReceipt;
      const serving = options.observeServing?.(attemptId);
      return settle(
        serving !== null &&
          serving !== undefined &&
          serving.epochKey === receipt.epochKey &&
          serving.controlGeneration === receipt.controlGeneration &&
          serving.successorInstanceId === receipt.successor.instanceId
          ? { kind: 'committed', receipt }
          : { kind: 'deferred', reason: 'durable serving record is unavailable' },
      );
    }
    const { intent, preparation } = observed;
    if (preparation === null || preparation.attemptId !== attemptId) {
      return settle({ kind: 'refused', reason: 'attempt is not prepared' });
    }
    const serving = options.observeServing?.(attemptId);
    if (serving !== null && serving !== undefined && intent.recoveryAttemptId === attemptId) {
      return recoveryServes(context, intent, serving.successorInstanceId);
    }
    if (serving !== null && serving !== undefined) {
      if (
        preparation.ready === null ||
        preparation.targetKey !== successionTargetKey(intent.target) ||
        (serving.epochKey !== preparation.epochKey && !options.retirementServing?.(attemptId, preparation.epochKey)) ||
        serving.successorInstanceId.length === 0 ||
        !Number.isSafeInteger(serving.controlGeneration) ||
        serving.controlGeneration < 1 ||
        !Number.isFinite(Date.parse(serving.recordedAt)) ||
        (intent.attemptDeadline !== null && Date.parse(serving.recordedAt) > Date.parse(intent.attemptDeadline))
      ) {
        return settle({ kind: 'deferred', reason: 'durable serving record does not match the prepared attempt' });
      }
      const receipt: NonNullable<UpgradeIntent['completionReceipt']> = {
        kind: 'serving',
        attemptId,
        successor: {
          instanceId: serving.successorInstanceId,
          pid: preparation.ready.successorPid,
          incarnation:
            intent.attemptChild?.attemptId === attemptId && intent.attemptChild.pid === preparation.ready.successorPid
              ? intent.attemptChild.incarnation
              : null,
          build: intent.target.build,
        },
        epochKey: serving.epochKey,
        controlGeneration: serving.controlGeneration,
        acceptedObligations: preparation.receipts.map((ownerReceipt) => ({
          owner: ownerReceipt.owner,
          receiptId: ownerReceipt.receiptId,
          controlGeneration: serving.controlGeneration,
        })),
        recordedAt: serving.recordedAt,
      };
      writeRefusal = 'deferred';
      return {
        kind: 'write',
        expectedRevision: intent.revision,
        change: { ...intent, disposition: 'completed', completionReceipt: receipt },
        settle: () => {
          options.onIntentChanged?.();
          // A target queued behind this attempt is adopted by the pass after its receipt.
          notifyObligationChange();
          return { kind: 'committed', receipt };
        },
      };
    }
    if (!currentPreparation(intent, preparation, options)) {
      if (committing(intent)) return settle({ kind: 'deferred', reason: 'succession attempt is committing' });
      writeRefusal = 'refused';
      return writeThen(
        intent,
        {
          ...intent,
          disposition: 'deferred',
          blockers: [{ owner: 'preparation', reason: 'preparation is stale' }],
          retryCondition:
            staleCause(intent, preparation, options) === 'target-change'
              ? { kind: 'target-change', evidence: 'target identity or capability declaration changed' }
              : { kind: 'obligation-change', evidence: 'epoch or admission revision changed' },
        },
        { kind: 'refused', reason: 'preparation is stale' },
      );
    }
    if (preparation.stage !== 'ready') return settle({ kind: 'deferred', reason: 'successor has not reported ready' });
    return settle({ kind: 'deferred', reason: 'awaiting durable serving record' });
  });
  return decisionOf(outcome, writeRefusal);
}

/**
 * A same-build recovery stands in for a failed target, so it earns no completion receipt: the target keeps the hold
 * its failed attempt left, and the recovery that serves becomes the incumbent owning the intent. Only that process
 * records it, because no other observer can write its identity.
 */
function recoveryServes(
  context: SettlementContext,
  intent: UpgradeIntent,
  successorInstanceId: string,
): UpgradeIntentCasStep<SuccessionDecision> {
  const { options, notifyObligationChange } = context;
  const self = options.incumbent();
  if (successorInstanceId !== self.instanceId) {
    return settle({ kind: 'deferred', reason: 'a serving same-build recovery records its own serving' });
  }
  return {
    kind: 'write',
    expectedRevision: intent.revision,
    change: {
      ...intent,
      incumbent: self,
      attemptId: null,
      attemptChild: null,
      attemptOwner: null,
      attemptDeadline: null,
      recoveryAttemptId: null,
      recoveryBuildSetId: null,
      recoveryGrantAttemptId: null,
      recoveryRetry: null,
      successionPreparation: null,
      disposition: 'deferred',
      blockers: [{ owner: 'succession-commit', reason: 'same-build recovery serves after failed target commit' }],
      ...failedAttemptRetry(
        intent,
        recoveryRetryOf(intent),
        'successor committed-open failure',
        options.runtime.time.now(),
      ),
      completionReceipt: null,
    },
    settle: (written) => {
      options.onIntentChanged?.();
      notifyObligationChange();
      return { kind: 'registered', intent: written };
    },
  };
}

async function recertify(context: SettlementContext, attemptId: string): Promise<SuccessionDecision> {
  const { options, status } = context;
  const observed = status();
  if (observed.kind !== 'readable' || observed.preparation?.attemptId !== attemptId) {
    return { kind: 'refused', reason: 'attempt is not prepared' };
  }
  const { intent, preparation } = observed;
  const declared = readSuccessionCapabilities(
    options.runtime,
    join(intent.target.pluginRootLabel, 'bridge'),
    intent.target.build,
  );
  if (declared.kind === 'invalid') return { kind: 'refused', reason: 'target succession declaration is invalid' };
  const capabilities = declared.kind === 'declared' ? declared.capabilities : emptyCapabilities(intent);
  if (JSON.stringify(capabilities) !== preparation.capabilitiesKey) {
    return { kind: 'stale', reason: 'target capabilities changed after preparation', cause: 'target-change' };
  }
  const certified = await recertifyUntransferableOwners(
    options.owners,
    attemptId,
    capabilities,
    options.requiredOwners,
  );
  return certified.kind === 'prepared'
    ? { kind: 'prepared', preparation }
    : { kind: 'deferred', reason: 'succession obligations began after preparation', blockers: certified.blockers };
}
