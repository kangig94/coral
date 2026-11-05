import {
  servingDeadlineOf,
  upgradeTargetBuildKey,
  type AttemptRetry,
  type UpgradeIntent,
} from '../../infra/upgrade-intent.js';
import { successionTargetKey } from './protocol.js';

export const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;

const TRANSIENT_RETRY_LIMIT = 6;
const OBLIGATION_RETRY_LIMIT = 6;

type TransientRetry = NonNullable<UpgradeIntent['transientRetry']>;
type ObligationRetry = NonNullable<UpgradeIntent['obligationRetry']>;

export type FailedAttemptRetry = Readonly<{
  retryCondition: NonNullable<UpgradeIntent['retryCondition']>;
  disposition?: 'closed';
  servingDeadline?: UpgradeIntent['servingDeadline'];
  legacyRetirement?: boolean;
  blockers?: UpgradeIntent['blockers'];
  transientRetry?: TransientRetry;
  obligationRetry?: ObligationRetry;
}>;

/** A record for another target never delays or bounds the current target. */
function transientRetryOf(intent: UpgradeIntent): TransientRetry | null {
  const retry = intent.transientRetry;
  return retry !== undefined && retry.targetKey === successionTargetKey(intent.target) ? retry : null;
}

function obligationRetryOf(intent: UpgradeIntent): ObligationRetry | null {
  const retry = intent.obligationRetry;
  return retry !== undefined && retry !== null && retry.targetKey === successionTargetKey(intent.target) ? retry : null;
}

function backoffMs(failures: number): number {
  return Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_BASE_MS * 2 ** (failures - 1));
}

export function attemptRetryAtMs(intent: UpgradeIntent): number | null {
  const backoffs = [transientRetryOf(intent), obligationRetryOf(intent)].flatMap((retry) =>
    retry === null ? [] : [Date.parse(retry.retryAfter)],
  );
  return backoffs.length === 0 ? null : Math.max(...backoffs);
}

export function withQuiescentCutoverBlocker(
  blockers: UpgradeIntent['blockers'],
  reason: string,
): UpgradeIntent['blockers'] {
  return [...blockers.filter((entry) => entry.owner !== 'quiescent-cutover'), { owner: 'quiescent-cutover', reason }];
}

/** Transient failures are counted on the intent, so a restart must not reset the backoff or bound. */
export function failedAttemptRetry(
  intent: UpgradeIntent,
  retry: AttemptRetry,
  targetChangeEvidence: string,
  nowMs: number,
): FailedAttemptRetry {
  const targetKey = upgradeTargetBuildKey(intent.target);
  const previous = servingDeadlineOf(intent);
  const misses = retry.kind === 'transient' && retry.servingDeadline === true ? (previous?.misses ?? 0) + 1 : 0;
  const servingDeadline = {
    targetKey,
    misses,
    cutoverAt: null,
    retirementIncumbent: null,
    targetRevalidation: null,
    reason: null,
    outcome: 'waiting' as const,
  };
  if (misses >= 2) {
    const cutoverAt = previous?.cutoverAt ?? new Date(nowMs + 10 * 60_000).toISOString();
    const reason = `quiescent-cutover after ${misses} serving-deadline misses; ordinary startup after incumbent retirement; handoff drain by ${cutoverAt}`;
    return {
      servingDeadline: { ...servingDeadline, cutoverAt },
      legacyRetirement: true,
      blockers: withQuiescentCutoverBlocker(intent.blockers, reason),
      retryCondition: { kind: 'incumbent-retirement', evidence: reason },
    };
  }
  if (misses === 1)
    return {
      servingDeadline,
      retryCondition: {
        kind: 'attempt-expiry',
        evidence: 'first serving-deadline miss; retry once before quiescent cutover',
      },
      transientRetry: {
        targetKey: successionTargetKey(intent.target),
        failures: Math.max(1, transientRetryOf(intent)?.failures ?? 0),
        retryAfter: new Date(nowMs + TRANSIENT_RETRY_BASE_MS).toISOString(),
      },
    };
  return { ...ordinaryFailedAttemptRetry(intent, retry, targetChangeEvidence, nowMs), servingDeadline };
}

export function quiescentCutoverAt(intent: UpgradeIntent): number | null {
  const policy = servingDeadlineOf(intent);
  return policy !== undefined && policy.cutoverAt !== null ? Date.parse(policy.cutoverAt) : null;
}

function ordinaryFailedAttemptRetry(
  intent: UpgradeIntent,
  retry: AttemptRetry,
  targetChangeEvidence: string,
  nowMs: number,
): FailedAttemptRetry {
  if (retry.kind === 'target-change') {
    return { retryCondition: { kind: 'target-change', evidence: targetChangeEvidence } };
  }
  if (retry.obligationChange === true) {
    const changes = Math.min((obligationRetryOf(intent)?.changes ?? 0) + 1, OBLIGATION_RETRY_LIMIT + 1);
    const obligationRetry = {
      targetKey: successionTargetKey(intent.target),
      changes,
      retryAfter: new Date(nowMs + Math.max(retry.retryAfterMs, backoffMs(changes))).toISOString(),
    };
    return {
      retryCondition: {
        kind: 'obligation-change',
        evidence: `an obligation change outdated the attempt; retries after ${obligationRetry.retryAfter}`,
      },
      obligationRetry,
    };
  }
  const failures = (transientRetryOf(intent)?.failures ?? 0) + 1;
  const transientRetry = {
    targetKey: successionTargetKey(intent.target),
    failures,
    retryAfter: new Date(nowMs + Math.max(retry.retryAfterMs, backoffMs(failures))).toISOString(),
  };
  if (failures > TRANSIENT_RETRY_LIMIT) {
    return {
      disposition: 'closed',
      retryCondition: {
        kind: 'target-change',
        evidence: `${TRANSIENT_RETRY_LIMIT} transient attempt failures exhausted this target's retries`,
      },
      transientRetry,
    };
  }
  return {
    retryCondition: {
      kind: 'attempt-expiry',
      evidence: `transient attempt failure ${failures} of ${TRANSIENT_RETRY_LIMIT} this target may spend; retries after ${transientRetry.retryAfter}`,
    },
    transientRetry,
  };
}

export function recoveryRetryOf(intent: UpgradeIntent): AttemptRetry {
  return intent.recoveryRetry ?? { kind: 'target-change' };
}
