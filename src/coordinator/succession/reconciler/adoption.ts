import type {
  UpgradeIntent,
  UpgradeIntentChange,
  UpgradeIntentCasStep,
  UpgradeIntentRead,
} from '../../../infra/upgrade-intent.js';
import { retryUpgradeIntentCas } from '../../../infra/upgrade-intent.js';
import { observeRecordedDeath } from '../startup.js';
import {
  ADOPTION_BLOCKER_OWNER,
  decisionOf,
  incumbentKey,
  requestedIntent,
  settle,
  withoutAdoptionBlocker,
} from '../intent-transitions.js';
import type { SuccessionDecision, SuccessionReconcilerOptions } from './index.js';

type TargetRequest = Readonly<{ requestId: string; target: UpgradeIntent['target'] }>;

export function createSuccessionIntentAdoption(input: {
  options: SuccessionReconcilerOptions;
  notifyObligationChange: () => void;
  writeThen: (
    intent: UpgradeIntent,
    change: UpgradeIntentChange,
    decision: SuccessionDecision,
  ) => UpgradeIntentCasStep<SuccessionDecision>;
}): Readonly<{
  adopt: (intent: UpgradeIntent) => Promise<SuccessionDecision>;
  adoptNextTarget: (intent: UpgradeIntent, queued: TargetRequest) => Promise<SuccessionDecision>;
  close: (intent: UpgradeIntent) => Promise<SuccessionDecision>;
}> {
  const { options, notifyObligationChange, writeThen } = input;
  /**
   * The serving incumbent owns an intent whose recorded incumbent is proven gone, keeping its disposition, hold, and
   * retry. An attempt still named belongs to startup. An unproven exit adopts nothing and is recorded as a blocker
   * the adoption removes; the next pass, or the retry interval, looks again.
   */
  async function adopt(intent: UpgradeIntent): Promise<SuccessionDecision> {
    const recorded = intent.incumbent;
    if (intent.attemptId !== null) {
      return { kind: 'deferred', reason: 'upgrade intent names another incumbent and its attempt' };
    }
    if (options.epochKey() === null) {
      return { kind: 'deferred', reason: 'upgrade intent names another incumbent; this process does not serve yet' };
    }
    const unchanged = (observed: UpgradeIntentRead): observed is Extract<UpgradeIntentRead, { kind: 'readable' }> =>
      observed.kind === 'readable' &&
      observed.intent.requestId === intent.requestId &&
      observed.intent.attemptId === null &&
      observed.intent.disposition !== 'closed' &&
      observed.intent.disposition !== 'completed' &&
      incumbentKey(observed.intent.incumbent) === incumbentKey(recorded);
    const liveness = observeRecordedDeath(recorded);
    if (liveness !== 'absent') {
      const reason = `recorded incumbent ${recorded.instanceId} (pid ${recorded.pid}) is ${liveness}; adoption waits until its exit is proven`;
      const held: SuccessionDecision = { kind: 'deferred', reason };
      const blocker = { owner: ADOPTION_BLOCKER_OWNER, reason };
      void (await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
        !unchanged(observed) ||
        observed.intent.blockers.some((entry) => entry.owner === blocker.owner && entry.reason === blocker.reason)
          ? settle(held)
          : writeThen(
              observed.intent,
              {
                ...observed.intent,
                blockers: [...withoutAdoptionBlocker(observed.intent.blockers), blocker],
              },
              held,
            ),
      ));
      return held;
    }
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
      if (!unchanged(observed)) {
        return settle({ kind: 'deferred', reason: 'upgrade intent changed before adoption' });
      }
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: {
          ...observed.intent,
          incumbent: options.incumbent(),
          blockers: withoutAdoptionBlocker(observed.intent.blockers),
        },
        settle: (written) => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'registered', intent: written };
        },
      };
    });
    return decisionOf(outcome, 'deferred');
  }

  async function adoptNextTarget(intent: UpgradeIntent, queued: TargetRequest): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
      if (observed.kind !== 'readable' || observed.intent.revision !== intent.revision) {
        return settle({ kind: 'deferred', reason: 'upgrade intent changed before its queued target was adopted' });
      }
      return {
        kind: 'write',
        expectedRevision: intent.revision,
        change: requestedIntent(queued, options.incumbent(), null),
        settle: (written) => {
          options.onIntentChanged?.();
          notifyObligationChange();
          return { kind: 'registered', intent: written };
        },
      };
    });
    return decisionOf(outcome, 'deferred');
  }

  async function close(intent: UpgradeIntent): Promise<SuccessionDecision> {
    const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) =>
      observed.kind === 'readable' && observed.intent.revision === intent.revision
        ? writeThen(
            intent,
            { ...intent, disposition: 'closed', blockers: [], retryCondition: null, successionPreparation: null },
            { kind: 'refused', reason: 'target does not strictly outrank the incumbent' },
          )
        : settle({ kind: 'deferred', reason: 'upgrade intent changed before it closed' }),
    );
    return decisionOf(outcome, 'deferred');
  }

  return { adopt, adoptNextTarget, close };
}
