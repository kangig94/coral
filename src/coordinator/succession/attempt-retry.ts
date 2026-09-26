import { z } from 'zod';

import type { UpgradeIntent } from '../../infra/upgrade-intent.js';
import { successionTargetKey } from './protocol.js';

export const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;
/** Consecutive transient failures one target may spend before it waits like a decisive failure. */
const TRANSIENT_RETRY_LIMIT = 6;

/**
 * What ends the hold a failed attempt leaves. A transient failure is retried after a backoff; a decisive one waits
 * for another target, because the same target would fail the same way.
 */
const attemptRetrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transient'), retryAfterMs: z.number().int().nonnegative() }).passthrough(),
  z.object({ kind: z.literal('target-change') }).passthrough(),
]);

export type AttemptRetry = z.infer<typeof attemptRetrySchema>;

/** Consecutive transient failures of one target, and the earliest time its next attempt may launch. */
const transientRetrySchema = z
  .object({
    targetKey: z.string().min(1),
    failures: z.number().int().positive(),
    retryAfter: z.string().datetime(),
  })
  .passthrough();

type TransientRetry = z.infer<typeof transientRetrySchema>;

export type FailedAttemptRetry = Readonly<{
  retryCondition: NonNullable<UpgradeIntent['retryCondition']>;
  transientRetry?: TransientRetry;
}>;

/** A record for another target, or one this build cannot read, never delays or bounds the current target. */
function transientRetryOf(intent: UpgradeIntent): TransientRetry | null {
  const parsed = transientRetrySchema.safeParse(intent.transientRetry);
  return parsed.success && parsed.data.targetKey === successionTargetKey(intent.target) ? parsed.data : null;
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
        evidence: `${TRANSIENT_RETRY_LIMIT} consecutive transient attempt failures exhausted this target's retries`,
      },
      transientRetry,
    };
  }
  return {
    retryCondition: {
      kind: 'attempt-expiry',
      evidence: `transient attempt failure ${failures} of ${TRANSIENT_RETRY_LIMIT}; retries after ${transientRetry.retryAfter}`,
    },
    transientRetry,
  };
}

/** The failure a same-build recovery stands in for; a grant without one keeps its target decisive. */
export function recoveryRetryOf(intent: UpgradeIntent): AttemptRetry {
  const parsed = attemptRetrySchema.safeParse(intent.recoveryRetry);
  return parsed.success ? parsed.data : { kind: 'target-change' };
}
