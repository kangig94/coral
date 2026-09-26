import type { AttemptRetry, UpgradeIntent } from '../../infra/upgrade-intent.js';
import { successionTargetKey } from './protocol.js';

export const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;
/**
 * Transient failures one target may spend in total before it waits like a decisive failure. Only a target change
 * restarts the count: an attempt's one success is completion, which ends the target, so no success can separate
 * two failures of it, and a bound that restarts on anything else would not bound the target.
 */
const TRANSIENT_RETRY_LIMIT = 6;

type TransientRetry = NonNullable<UpgradeIntent['transientRetry']>;

export type FailedAttemptRetry = Readonly<{
  retryCondition: NonNullable<UpgradeIntent['retryCondition']>;
  transientRetry?: TransientRetry;
}>;

/** A record for another target never delays or bounds the current target. */
function transientRetryOf(intent: UpgradeIntent): TransientRetry | null {
  const retry = intent.transientRetry;
  return retry !== undefined && retry.targetKey === successionTargetKey(intent.target) ? retry : null;
}

/** When the intent's target may next launch an attempt; null when no transient backoff binds it. */
export function transientRetryAtMs(intent: UpgradeIntent): number | null {
  const retry = transientRetryOf(intent);
  return retry === null ? null : Date.parse(retry.retryAfter);
}

/**
 * The retry condition a failed attempt leaves on the intent's target. Transient failures are counted on the
 * intent, so a restart neither resets the backoff nor the bound; exhausting the bound turns the hold into the
 * decisive one, which a newer target or the incumbent's natural retirement ends.
 */
export function failedAttemptRetry(
  intent: UpgradeIntent,
  retry: AttemptRetry,
  targetChangeEvidence: string,
  nowMs: number,
): FailedAttemptRetry {
  if (retry.kind === 'target-change') {
    return { retryCondition: { kind: 'target-change', evidence: targetChangeEvidence } };
  }
  const failures = (transientRetryOf(intent)?.failures ?? 0) + 1;
  const backoffMs = Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_BASE_MS * 2 ** (failures - 1));
  const transientRetry = {
    targetKey: successionTargetKey(intent.target),
    failures,
    retryAfter: new Date(nowMs + Math.max(retry.retryAfterMs, backoffMs)).toISOString(),
  };
  if (failures > TRANSIENT_RETRY_LIMIT) {
    return {
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

/** The failure a same-build recovery stands in for; a grant without one keeps its target decisive. */
export function recoveryRetryOf(intent: UpgradeIntent): AttemptRetry {
  return intent.recoveryRetry ?? { kind: 'target-change' };
}
