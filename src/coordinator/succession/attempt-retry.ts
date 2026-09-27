import type { AttemptRetry, UpgradeIntent } from '../../infra/upgrade-intent.js';
import { successionTargetKey } from './protocol.js';

export const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;
/**
 * Transient failures one target may spend in total before its intent closes. A different target or a new request
 * starts a new count; an attempt's one success is completion, so no success can separate two failures of it.
 */
const TRANSIENT_RETRY_LIMIT = 6;
const OBLIGATION_RETRY_LIMIT = 6;

type TransientRetry = NonNullable<UpgradeIntent['transientRetry']>;
type ObligationRetry = NonNullable<UpgradeIntent['obligationRetry']>;

export type FailedAttemptRetry = Readonly<{
  retryCondition: NonNullable<UpgradeIntent['retryCondition']>;
  disposition?: 'closed';
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

/** When the intent's target may next launch an attempt; null when no backoff binds it. */
export function attemptRetryAtMs(intent: UpgradeIntent): number | null {
  const backoffs = [transientRetryOf(intent), obligationRetryOf(intent)].flatMap((retry) =>
    retry === null ? [] : [Date.parse(retry.retryAfter)],
  );
  return backoffs.length === 0 ? null : Math.max(...backoffs);
}

/**
 * The retry condition a failed attempt leaves on the intent's target. Transient failures are counted on the
 * intent, so a restart neither resets the backoff nor the bound; exhausting the bound closes the failed request.
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
  if (retry.obligationChange === true) {
    const changes = (obligationRetryOf(intent)?.changes ?? 0) + 1;
    const obligationRetry = {
      targetKey: successionTargetKey(intent.target),
      changes,
      retryAfter: new Date(nowMs + Math.max(retry.retryAfterMs, backoffMs(changes))).toISOString(),
    };
    if (changes > OBLIGATION_RETRY_LIMIT) {
      return {
        disposition: 'closed',
        retryCondition: {
          kind: 'target-change',
          evidence: `${OBLIGATION_RETRY_LIMIT} obligation attempt failures exhausted this target's retries`,
        },
        obligationRetry,
      };
    }
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

/** The failure a same-build recovery stands in for; a grant without one keeps its target decisive. */
export function recoveryRetryOf(intent: UpgradeIntent): AttemptRetry {
  return intent.recoveryRetry ?? { kind: 'target-change' };
}
