import type { RecoveryObservation } from '../../../recovery/phase-observation.js';
import { join } from 'node:path';

import {
  quarantineCorruptUpgradeIntent,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  upgradeRetirementCommitted,
  servingDeadlineOf,
  type UpgradeIntent,
} from '../../../infra/upgrade-intent.js';
import { attemptRetryAtMs, quiescentCutoverAt, withQuiescentCutoverBlocker } from '../attempt-retry.js';
import { readSuccessionCapabilities } from '../protocol.js';
import {
  endedUnder,
  LAUNCH_IN_FLIGHT,
  namedAttempts,
  outranks,
  recordsSelf,
  TARGET_CHANGE_HOLD_OWNERS,
} from '../intent-transitions.js';
import type {
  SuccessionDecision,
  SuccessionLaunch,
  SuccessionLaunchSettlement,
  SuccessionReconcilerOptions,
  SuccessionStatus,
} from './index.js';
import type { SuccessionReconcilerState } from './state.js';

const TARGET_REVALIDATION_MAX_MS = 60 * 60_000;

type ReconciliationContext = Readonly<{
  options: SuccessionReconcilerOptions;
  state: SuccessionReconcilerState;
  status: (requestId?: string) => SuccessionStatus;
  notifyObligationChange: () => void;
  adopt: (intent: UpgradeIntent) => Promise<SuccessionDecision>;
  adoptNextTarget: (
    intent: UpgradeIntent,
    queued: NonNullable<UpgradeIntent['nextTarget']>,
  ) => Promise<SuccessionDecision>;
  close: (intent: UpgradeIntent) => Promise<SuccessionDecision>;
  prepare: (requestId: string) => Promise<SuccessionDecision>;
  commit: (attemptId: string) => Promise<SuccessionDecision>;
  abort: (attemptId: string) => Promise<SuccessionDecision>;
}>;

export function createSuccessionReconciliationPass(
  context: ReconciliationContext,
): (observation?: RecoveryObservation) => Promise<SuccessionDecision> {
  return (observation) => reconcilePending(context, observation);
}

function wakeAt(context: ReconciliationContext, atMs: number): void {
  const { options, state, notifyObligationChange } = context;
  if (state.disposed) return;
  options.runtime.time.clearTimeout(state.backoffWake);
  state.backoffWake = options.runtime.time.setTimeout(
    notifyObligationChange,
    Math.max(0, atMs - options.runtime.time.now()),
  );
  state.backoffWake.unref?.();
}

async function retryUnservedMintDiscard(
  context: ReconciliationContext,
  intent: UpgradeIntent,
): Promise<SuccessionDecision | null> {
  const { options, notifyObligationChange } = context;
  const pending = intent.unservedMintDiscard ?? null;
  if (pending === null || options.discardUnservedMint === undefined) return null;
  const discarded = options.discardUnservedMint(pending.incumbentEpochKey, pending.attemptId);
  if (discarded.kind === 'held') {
    const formatChanges =
      options.storeFormatFingerprint !== undefined &&
      intent.target.build.storeFormatFingerprint !== options.storeFormatFingerprint;
    return formatChanges
      ? { kind: 'deferred', reason: `unserved retirement mint is not yet discarded (${discarded.reason})` }
      : null;
  }
  const cleared = await retryUpgradeIntentCas<boolean>(options.runDir, (observed) =>
    observed.kind === 'readable' && observed.intent.unservedMintDiscard?.attemptId === pending.attemptId
      ? {
          kind: 'write',
          expectedRevision: observed.intent.revision,
          change: { ...observed.intent, unservedMintDiscard: null },
          settle: () => true,
        }
      : { kind: 'settle', value: false },
  );
  if (cleared.kind !== 'settled' || !cleared.value) return null;
  notifyObligationChange();
  return { kind: 'deferred', reason: `unserved retirement mint was ${discarded.kind}` };
}

/** Grants survive only for attempts the intent names, the launched one, and the one being prepared. */
function dischargeUnnamedGrants(context: ReconciliationContext, intent: UpgradeIntent): void {
  const { options, state } = context;
  const retained = new Set([
    ...namedAttempts(intent),
    ...(state.launchedAttempt === null ? [] : [state.launchedAttempt]),
    ...(state.pendingAttempt === null ? [] : [state.pendingAttempt.attemptId]),
    ...state.preparingAttempts.keys(),
  ]);
  for (const owner of options.owners) {
    try {
      owner.dischargeGrants?.(retained);
    } catch (error: unknown) {
      options.onReconcileError?.(error);
    }
  }
}

async function landOwedClear(
  context: ReconciliationContext,
  owed: Extract<SuccessionLaunchSettlement, { kind: 'clear-owed' }>,
): Promise<SuccessionDecision | null> {
  const { options, state, notifyObligationChange } = context;
  const outcome = await retryUpgradeIntentCas<boolean>(options.runDir, (observed) =>
    observed.kind === 'readable' && observed.intent.attemptId === owed.attemptId
      ? {
          kind: 'write',
          expectedRevision: observed.intent.revision,
          change: owed.clear(observed.intent),
          settle: () => true,
        }
      : { kind: 'settle', value: false },
  );
  if (outcome.kind !== 'settled') {
    return {
      kind: 'deferred',
      reason: `a settled attempt's clearing write is owed (${outcome.kind === 'refused' ? outcome.problem : 'contended'})`,
    };
  }
  state.owedClear = null;
  if (!outcome.value) return null;
  options.onIntentChanged?.();
  notifyObligationChange();
  return { kind: 'deferred', reason: 'a settled attempt was cleared from the upgrade intent' };
}

async function reconcilePending(
  context: ReconciliationContext,
  observation?: RecoveryObservation,
): Promise<SuccessionDecision> {
  const { options, state, status, notifyObligationChange, adopt, adoptNextTarget, commit } = context;
  if (!state.disposed && state.owedClear !== null) {
    const owed = await landOwedClear(context, state.owedClear);
    if (owed !== null) return owed;
  }
  const observed = status();
  if (observed.kind === 'readable') observation?.record('upgrade-intents', { subjects: 1, reads: 1 });
  if (!state.disposed && observed.kind === 'corrupt' && state.launchedAttempt === null && state.owedClear === null) {
    if ((await quarantineCorruptUpgradeIntent(options.runDir)) === 'quarantined') {
      options.onIntentChanged?.();
      notifyObligationChange();
      return { kind: 'deferred', reason: 'corrupt upgrade intent was quarantined for a fresh request' };
    }
  }
  if (state.disposed || observed.kind !== 'readable') return { kind: 'deferred', reason: 'no active upgrade intent' };
  const { intent } = observed;
  const discardHold = await retryUnservedMintDiscard(context, intent);
  if (discardHold !== null) return discardHold;
  const queued = intent.nextTarget ?? null;
  const self = options.incumbent();
  if (endedUnder(intent, self)) dischargeUnnamedGrants(context, intent);
  if (intent.disposition === 'closed' || intent.disposition === 'completed') {
    return queued !== null && endedUnder(intent, self)
      ? adoptNextTarget(intent, queued)
      : { kind: 'deferred', reason: 'upgrade intent has ended' };
  }

  if (intent.attemptId !== null && (options.observeServing?.(intent.attemptId) ?? null) !== null) {
    return commit(intent.attemptId);
  }
  if (!recordsSelf(intent.incumbent, self)) return adopt(intent);
  return reconcileOwnedIntent(context, intent, self, queued);
}

async function reconcileOwnedIntent(
  context: ReconciliationContext,
  intent: UpgradeIntent,
  self: ReturnType<ReconciliationContext['options']['incumbent']>,
  queued: NonNullable<UpgradeIntent['nextTarget']> | null,
): Promise<SuccessionDecision> {
  const { options, state, adoptNextTarget, close } = context;

  if (
    intent.attemptId === null &&
    queued !== null &&
    intent.reason !== 'supervision-repair' &&
    !upgradeRetirementCommitted(intent)
  )
    return adoptNextTarget(intent, queued);
  let applies: boolean;
  try {
    applies = outranks(intent.target, self);
  } catch {
    return { kind: 'deferred', reason: 'target or incumbent version is invalid' };
  }
  if (!applies && intent.reason !== 'supervision-repair' && intent.attemptId === null) return close(intent);
  if (
    intent.disposition === 'deferred' &&
    intent.retryCondition?.kind === 'target-change' &&
    intent.blockers.some((blocker) => TARGET_CHANGE_HOLD_OWNERS.has(blocker.owner))
  ) {
    return { kind: 'deferred', reason: 'successor target must change after failed attempt' };
  }
  const cutover = await reconcileQuiescentCutover(context, intent);
  if (cutover !== null) return cutover;
  const retryAtMs = intent.attemptId === null ? attemptRetryAtMs(intent) : null;
  if (retryAtMs !== null && retryAtMs > options.runtime.time.now()) {
    wakeAt(context, retryAtMs);
    return {
      kind: 'deferred',
      reason: `failed attempt backs off until ${new Date(retryAtMs).toISOString()}`,
    };
  }
  if (options.commitAvailable !== true) {
    return { kind: 'deferred', reason: 'incumbent needs supervised legacy retirement' };
  }
  if (state.launchedAttempt !== null) return { kind: 'deferred', reason: LAUNCH_IN_FLIGHT };
  return launchPreparedAttempt(context, intent);
}

async function launchPreparedAttempt(
  context: ReconciliationContext,
  intent: UpgradeIntent,
): Promise<SuccessionDecision> {
  const { options, state, status, notifyObligationChange, prepare, commit, abort } = context;
  const prepared = await prepare(intent.requestId);
  if (prepared.kind !== 'prepared') return prepared;
  const declaration = readSuccessionCapabilities(
    options.runtime,
    join(intent.target.pluginRootLabel, 'bridge'),
    intent.target.build,
  );
  if (declaration.kind !== 'declared' || !declaration.capabilities.protocols.includes('commit')) {
    return { kind: 'deferred', reason: 'target needs supervised legacy retirement' };
  }
  const current = status(intent.requestId);
  if (current.kind !== 'readable' || current.preparation?.attemptId !== prepared.preparation.attemptId) {
    return { kind: 'deferred', reason: 'prepared attempt changed before launch' };
  }
  if (current.preparation.stage === 'ready') return commit(current.preparation.attemptId);
  if (
    current.intent.attemptDeadline !== null &&
    Date.parse(current.intent.attemptDeadline) <= options.runtime.time.now()
  ) {
    return abort(current.preparation.attemptId);
  }
  if (options.launchPrepared === undefined) {
    return { kind: 'deferred', reason: 'succession launch capability is not installed' };
  }
  if (revalidateUpgradeIntentTarget(current.intent).kind !== 'validated') {
    return { kind: 'deferred', reason: 'target build no longer validates at launch' };
  }
  const attemptId = current.preparation.attemptId;
  state.launchedAttempt = attemptId;
  let launch: SuccessionLaunch;
  try {
    launch = await options.launchPrepared(current.intent, current.preparation);
  } catch (error: unknown) {
    state.launchedAttempt = null;
    const aborted = await abort(attemptId);
    if (aborted.kind !== 'aborted') return aborted;
    throw error;
  }
  void launch.settled
    .then(
      (settlement) => {
        if (settlement.kind === 'clear-owed') state.owedClear = settlement;
      },
      () => undefined,
    )
    .finally(() => {
      state.launchedAttempt = null;
      notifyObligationChange();
    });
  return { kind: 'deferred', reason: 'successor launch is awaiting readiness' };
}

async function recordCutoverOutcome(
  context: ReconciliationContext,
  intent: UpgradeIntent,
  policy: NonNullable<UpgradeIntent['servingDeadline']>,
  outcome: 'waiting' | 'retiring' | 'unavailable' | 'unobservable',
  reason: string,
): Promise<SuccessionDecision> {
  const retryAt = outcome === 'unavailable' ? context.options.runtime.time.now() + TARGET_REVALIDATION_MAX_MS : null;
  const nextPolicy =
    retryAt === null
      ? policy
      : {
          ...policy,
          retirementIncumbent: null,
          targetRevalidation: {
            attempts: (policy.targetRevalidation?.attempts ?? 0) + 1,
            retryAt: new Date(retryAt).toISOString(),
          },
        };
  const outcomeReason =
    retryAt === null ? reason : `${reason}; automatic revalidation at ${new Date(retryAt).toISOString()}`;
  const written = await retryUpgradeIntentCas(context.options.runDir, (observed) =>
    observed.kind === 'readable' && observed.intent.revision === intent.revision
      ? {
          kind: 'write',
          expectedRevision: intent.revision,
          change: {
            ...intent,
            servingDeadline: {
              ...nextPolicy,
              reason: outcomeReason,
              outcome,
              retirementIncumbent:
                outcome === 'retiring'
                  ? (nextPolicy.retirementIncumbent ?? context.options.incumbent().instanceId)
                  : (nextPolicy.retirementIncumbent ?? null),
            },
            retryCondition: { kind: 'incumbent-retirement', evidence: outcomeReason },
            blockers: withQuiescentCutoverBlocker(intent.blockers, outcomeReason),
          },
          settle: () => {
            if (outcome === 'retiring') {
              context.state.retirementRequested = true;
              context.options.retireForCutover?.();
            }
            return true;
          },
        }
      : { kind: 'settle', value: false },
  );
  if (written.kind !== 'settled' || !written.value)
    return { kind: 'deferred', reason: 'upgrade intent changed before cutover outcome was committed' };
  if (outcome !== 'retiring') context.notifyObligationChange();
  return { kind: 'deferred', reason: outcomeReason };
}

async function reconcileQuiescentCutover(
  context: ReconciliationContext,
  intent: UpgradeIntent,
): Promise<SuccessionDecision | null> {
  const { options } = context;
  const self = options.incumbent();
  const policy = servingDeadlineOf(intent);
  const cutoverAt = intent.attemptId === null ? quiescentCutoverAt(intent) : null;
  if (cutoverAt !== null && policy !== undefined) {
    if (intent.legacyRetirement !== true || !intent.blockers.some((entry) => entry.owner === 'quiescent-cutover')) {
      void (await retryUpgradeIntentCas(options.runDir, (observed) =>
        observed.kind === 'readable' && observed.intent.revision === intent.revision
          ? {
              kind: 'write',
              expectedRevision: intent.revision,
              change: {
                ...intent,
                legacyRetirement: true,
                disposition: 'deferred',
                blockers: withQuiescentCutoverBlocker(
                  intent.blockers,
                  policy.reason ?? 'ordinary startup after incumbent retirement',
                ),
                retryCondition: {
                  kind: 'incumbent-retirement',
                  evidence: policy.reason ?? `quiescent-cutover; handoff drain by ${new Date(cutoverAt).toISOString()}`,
                },
              },
              settle: () => undefined,
            }
          : { kind: 'settle', value: undefined },
      ));
      context.notifyObligationChange();
      return { kind: 'deferred', reason: 'quiescent-cutover restored after request renewal' };
    }
    if ((policy.retirementIncumbent ?? null) !== null && policy.retirementIncumbent !== self.instanceId) {
      return recordCutoverOutcome(
        context,
        intent,
        policy,
        'unavailable',
        'ordinary startup retained the incumbent build under controller custody; hot succession suppressed; target remains selected for a later ordinary startup',
      );
    }
    if (context.state.retirementRequested && policy.retirementIncumbent === self.instanceId)
      return { kind: 'deferred', reason: 'committed retirement awaits ordinary startup' };
    if (options.runtime.time.now() >= cutoverAt || options.liveJobIds?.().length === 0) {
      const validation = await revalidateCutoverTarget(context, intent, policy);
      if (validation !== null) return validation;
      return recordCutoverOutcome(
        context,
        intent,
        policy,
        'retiring',
        'quiescent-cutover requests one incumbent handoff; supervisor owns ordinary startup',
      );
    } else {
      wakeAt(context, cutoverAt);
    }
    return { kind: 'deferred', reason: intent.retryCondition?.evidence ?? 'quiescent-cutover awaits retirement' };
  }
  return null;
}

async function revalidateCutoverTarget(
  context: ReconciliationContext,
  intent: UpgradeIntent,
  policy: NonNullable<UpgradeIntent['servingDeadline']>,
): Promise<SuccessionDecision | null> {
  const retry = policy.targetRevalidation;
  const now = context.options.runtime.time.now();
  if (retry?.retryAt !== undefined && retry.retryAt !== null && Date.parse(retry.retryAt) > now) {
    wakeAt(context, Date.parse(retry.retryAt));
    return { kind: 'deferred', reason: policy.reason ?? 'target evidence awaits paced revalidation' };
  }
  const validation = revalidateUpgradeIntentTarget(intent);
  if (validation.kind === 'validated') return null;
  if (validation.kind === 'invalid')
    return recordCutoverOutcome(
      context,
      intent,
      policy,
      'unavailable',
      'target no longer validates; hot succession suppressed',
    );
  const attempts = (retry?.attempts ?? 0) + 1;
  const delayMs = attempts < 3 ? 5_000 : Math.min(TARGET_REVALIDATION_MAX_MS, 60_000 * 2 ** (attempts - 3));
  const retryAt = new Date(now + delayMs).toISOString();
  const reason = `target evidence is unobservable after ${attempts} observations; automatic revalidation at ${retryAt}; hot succession suppressed`;
  const result = await recordCutoverOutcome(
    context,
    intent,
    { ...policy, targetRevalidation: { attempts, retryAt } },
    attempts >= 3 ? 'unobservable' : 'waiting',
    reason,
  );
  wakeAt(context, Date.parse(retryAt));
  return result;
}
