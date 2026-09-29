import { compareProductVersions } from '../../infra/product-version.js';
import { observeRecordedDeath } from './startup.js';
import {
  revalidateUpgradeIntentTarget,
  retryUpgradeIntentCas,
  type UpgradeIntent,
  type UpgradeIntentCasOutcome,
  type UpgradeIntentCasStep,
  type UpgradeIntentChange,
} from '../../infra/upgrade-intent.js';
import { successionPreparationSchema, successionTargetKey } from './protocol.js';
import type { SuccessionDecision, SuccessionReconciler, SuccessionReconcilerOptions } from './reconciler/index.js';

type IncumbentIdentity = UpgradeIntent['incumbent'];
type Target = UpgradeIntent['target'];
type TargetRequest = Readonly<{ requestId: string; target: Target }>;

type TargetCustodyDisposition =
  | Readonly<{ kind: 'blocked-by-jobs'; formatChanges: true; liveJobs: readonly string[] }>
  | Readonly<{ kind: 'deferred' | 'eligible'; formatChanges: boolean }>;

type TargetCustodyClassification =
  | Readonly<{ kind: 'invalid-target' }>
  | Readonly<{ kind: 'validated-target'; disposition: () => TargetCustodyDisposition }>;

export function classifyTargetCustody(
  intent: UpgradeIntent,
  options: SuccessionReconcilerOptions,
): TargetCustodyClassification {
  if (revalidateUpgradeIntentTarget(intent).kind !== 'validated') return { kind: 'invalid-target' };
  return {
    kind: 'validated-target',
    disposition: () => {
      const formatChanges =
        options.storeFormatFingerprint !== undefined &&
        intent.target.build.storeFormatFingerprint !== options.storeFormatFingerprint;
      const liveJobs = formatChanges ? (options.liveJobIds?.() ?? []) : [];
      if (liveJobs.length > 0) return { kind: 'blocked-by-jobs', formatChanges: true, liveJobs };
      return { kind: intent.disposition === 'deferred' ? 'deferred' : 'eligible', formatChanges };
    },
  };
}

export function settle(decision: SuccessionDecision): UpgradeIntentCasStep<SuccessionDecision> {
  return { kind: 'settle', value: decision };
}

export function decisionOf(
  outcome: UpgradeIntentCasOutcome<SuccessionDecision>,
  refusal: 'refused' | 'deferred',
): SuccessionDecision {
  switch (outcome.kind) {
    case 'settled':
      return outcome.value;
    case 'refused':
      return { kind: refusal, reason: `upgrade intent is ${outcome.problem}` };
    case 'exhausted':
      return { kind: 'deferred', reason: 'upgrade intent changed concurrently' };
  }
}

export function sameTarget(left: Target, right: Target): boolean {
  return successionTargetKey(left) === successionTargetKey(right);
}

export function supersedes(candidate: Target, than: Target): boolean {
  if (candidate.build.flavor !== than.build.flavor || sameTarget(candidate, than)) return false;
  try {
    return compareProductVersions(candidate.build.version, than.build.version) > 0;
  } catch {
    return false;
  }
}

export function requestedIntent(
  request: TargetRequest,
  incumbent: IncumbentIdentity,
  queued: TargetRequest | null | undefined,
  reason: 'upgrade' | 'supervision-repair' = 'upgrade',
): UpgradeIntentChange {
  return {
    requestId: request.requestId,
    reason,
    incumbent,
    target: request.target,
    attemptId: null,
    attemptChild: null,
    attemptOwner: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: null,
    attemptDeadline: null,
    completionReceipt: null,
    successionPreparation: null,
    recoveryAttemptId: null,
    recoveryBuildSetId: null,
    recoveryGrantAttemptId: null,
    recoveryRetry: null,
    obligationRetry: null,
    nextTarget: queued !== null && queued !== undefined && supersedes(queued.target, request.target) ? queued : null,
  };
}

export function incumbentKey(incumbent: IncumbentIdentity): string {
  return JSON.stringify([
    incumbent.instanceId,
    incumbent.pid,
    incumbent.incarnation,
    incumbent.version,
    incumbent.bundleHash,
    incumbent.flavor,
  ]);
}

export function recordsSelf(recorded: IncumbentIdentity, self: IncumbentIdentity): boolean {
  return incumbentKey({ ...recorded, incarnation: recorded.incarnation ?? self.incarnation }) === incumbentKey(self);
}

export function committing(intent: UpgradeIntent): boolean {
  return intent.disposition === 'attempting' && intent.attemptId !== null && intent.attemptOwner?.kind === 'incumbent';
}

export function endedUnder(intent: UpgradeIntent, self: IncumbentIdentity): boolean {
  return intent.disposition === 'completed'
    ? intent.completionReceipt?.successor.instanceId === self.instanceId
    : recordsSelf(intent.incumbent, self);
}

export function holdsRecovery(intent: UpgradeIntent): boolean {
  return (
    intent.attemptId !== null &&
    intent.attemptOwner?.kind === 'incumbent' &&
    intent.recoveryAttemptId === intent.attemptId
  );
}

export function heldByCommit(intent: UpgradeIntent): boolean {
  return committing(intent) || holdsRecovery(intent);
}

export function namedAttempts(intent: UpgradeIntent): string[] {
  const preparation = successionPreparationSchema.safeParse(intent.successionPreparation);
  return [
    intent.attemptId,
    intent.recoveryAttemptId,
    intent.completionReceipt?.attemptId,
    ...(preparation.success
      ? [preparation.data.attemptId, ...preparation.data.receipts.map((receipt) => receipt.attemptId)]
      : []),
  ].filter((attemptId): attemptId is string => typeof attemptId === 'string');
}

export const LAUNCH_IN_FLIGHT = 'launched attempt is settled only by its commit';
export const RECOVERY_HOLDS_INTENT = 'a same-build recovery attempt is settled only by its recovery or by startup';

export const ADOPTION_BLOCKER_OWNER = 'succession-adoption';

export function withoutAdoptionBlocker(blockers: UpgradeIntent['blockers']): UpgradeIntent['blockers'] {
  return blockers.filter((entry) => entry.owner !== ADOPTION_BLOCKER_OWNER);
}

export const TARGET_CHANGE_HOLD_OWNERS = new Set(['succession-commit', 'succession-prepare', 'succession-startup']);

export function outranks(target: Target, incumbent: IncumbentIdentity): boolean {
  return (
    target.build.flavor === incumbent.flavor && compareProductVersions(target.build.version, incumbent.version) > 0
  );
}

async function requestSuccessionIntent(
  input: { requestId: string; target: Target },
  options: SuccessionReconcilerOptions,
  notifyObligationChange: () => void,
  currentLaunchedAttempt: () => string | null,
): Promise<SuccessionDecision> {
  const self = options.incumbent();
  try {
    if (
      input.target.build.flavor !== self.flavor ||
      compareProductVersions(input.target.build.version, self.version) <= 0
    ) {
      return { kind: 'refused', reason: 'target does not strictly outrank the incumbent' };
    }
  } catch {
    return { kind: 'refused', reason: 'target or incumbent version is invalid' };
  }
  const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
    if (observed.kind !== 'absent' && observed.kind !== 'readable') {
      return settle({ kind: 'refused', reason: `upgrade intent is ${observed.kind}` });
    }
    const current = observed.kind === 'readable' ? observed.intent : null;
    if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed') {
      if (
        current.attemptId !== null &&
        ((options.observeServing?.(current.attemptId) ?? null) !== null ||
          (current.attemptChild?.attemptId === current.attemptId &&
            observeRecordedDeath(current.attemptChild) !== 'absent') ||
          (recordsSelf(current.incumbent, self) &&
            (heldByCommit(current) || current.attemptId === currentLaunchedAttempt())))
      ) {
        return queueBehindSuccessionAttempt(current, input, options, notifyObligationChange);
      }
      let comparison: number;
      try {
        comparison = compareProductVersions(input.target.build.version, current.target.build.version);
      } catch {
        return settle({ kind: 'refused', reason: 'pending target version is invalid' });
      }
      if (
        sameTarget(current.target, input.target) ||
        (current.target.build.flavor === input.target.build.flavor &&
          comparison <= 0 &&
          revalidateUpgradeIntentTarget(current).kind === 'validated')
      ) {
        notifyObligationChange();
        return settle({ kind: 'registered', intent: current });
      }
      if (current.target.build.flavor !== input.target.build.flavor) {
        return settle({ kind: 'refused', reason: 'pending target has another build flavor' });
      }
    }
    return {
      kind: 'write',
      expectedRevision: current?.revision ?? null,
      change: requestedIntent(input, self, current?.nextTarget),
      settle: (written) => {
        options.onIntentChanged?.();
        notifyObligationChange();
        return { kind: 'registered', intent: written };
      },
    };
  });
  return decisionOf(outcome, 'refused');
}

async function requestSuccessionSupervisionRepair(
  input: { requestId: string; target: Target },
  options: SuccessionReconcilerOptions,
  notifyObligationChange: () => void,
): Promise<SuccessionDecision> {
  const self = options.incumbent();
  if (
    input.target.build.flavor !== self.flavor ||
    input.target.build.version !== self.version ||
    input.target.build.bundleHash !== self.bundleHash ||
    (options.runningBuildSetId !== undefined && input.target.build.buildSetId !== options.runningBuildSetId)
  )
    return { kind: 'refused', reason: 'supervision repair must use the serving build' };
  const outcome = await retryUpgradeIntentCas<SuccessionDecision>(options.runDir, (observed) => {
    if (observed.kind !== 'absent' && observed.kind !== 'readable')
      return settle({ kind: 'deferred', reason: `upgrade intent is ${observed.kind}` });
    const current = observed.kind === 'readable' ? observed.intent : null;
    const active = current !== null && current.disposition !== 'closed' && current.disposition !== 'completed';
    if (active) {
      let newerTargetCanTakeCustody = false;
      if (current.reason !== 'supervision-repair' && supersedes(current.target, input.target)) {
        const custody = classifyTargetCustody(current, options);
        newerTargetCanTakeCustody = custody.kind === 'validated-target' && custody.disposition().kind === 'eligible';
      }
      if (current.reason === 'supervision-repair' || newerTargetCanTakeCustody) {
        notifyObligationChange();
        return settle({ kind: 'registered', intent: current });
      }
      if (current.attemptId !== null) {
        notifyObligationChange();
        return settle({ kind: 'deferred', reason: 'existing succession attempt must settle before repair' });
      }
    }
    return {
      kind: 'write',
      expectedRevision: current?.revision ?? null,
      change: requestedIntent(
        input,
        self,
        !active
          ? null
          : current.nextTarget !== null &&
              current.nextTarget !== undefined &&
              supersedes(current.nextTarget.target, current.target)
            ? current.nextTarget
            : { requestId: current.requestId, target: current.target },
        'supervision-repair',
      ),
      settle: (written) => {
        options.onIntentChanged?.();
        notifyObligationChange();
        return { kind: 'registered', intent: written };
      },
    };
  });
  return decisionOf(outcome, 'deferred');
}

function queueBehindSuccessionAttempt(
  current: UpgradeIntent,
  input: TargetRequest,
  options: SuccessionReconcilerOptions,
  notifyObligationChange: () => void,
): UpgradeIntentCasStep<SuccessionDecision> {
  notifyObligationChange();
  const queued = current.nextTarget ?? null;
  if (
    !supersedes(input.target, current.target) ||
    (queued !== null && (sameTarget(queued.target, input.target) || !supersedes(input.target, queued.target)))
  ) {
    return settle({ kind: 'registered', intent: current });
  }
  return {
    kind: 'write',
    expectedRevision: current.revision,
    change: { ...current, nextTarget: { requestId: input.requestId, target: input.target } },
    settle: (written) => {
      options.onIntentChanged?.();
      return { kind: 'registered', intent: written };
    },
  };
}

export function createIntentTransitionRequests(
  options: SuccessionReconcilerOptions,
  notifyObligationChange: () => void,
  currentLaunchedAttempt: () => string | null,
): Pick<SuccessionReconciler, 'request' | 'repairSupervision'> {
  return {
    request: (input) => requestSuccessionIntent(input, options, notifyObligationChange, currentLaunchedAttempt),
    repairSupervision: (input) => requestSuccessionSupervisionRepair(input, options, notifyObligationChange),
  };
}
