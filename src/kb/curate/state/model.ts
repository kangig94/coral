import { z } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import { nowIsoString } from '../../../infra/time.js';
import type { EnvPort } from '../../../infra/port-types.js';
import { noteEntryId, parseKbEntryId, type KbEntryId } from '../../entry-types.js';

/**
 * Curate timing operator knobs (see §16(d) triage rule). Defaults match the
 * historical hardcoded values; operators tune via the matching `CORAL_CURATE_*`
 * env vars. Reducers below stay pure — they receive the resolved timings as
 * parameters; the env read happens at the scheduler/operations boundary.
 */
export const DEFAULT_CLAIM_STALE_MS = 15 * 60 * 1000;
export const DEFAULT_CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
export const DEFAULT_CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;

export const CORAL_CURATE_CLAIM_STALE_MS_ENV = 'CORAL_CURATE_CLAIM_STALE_MS';
export const CORAL_CURATE_TRANSIENT_RETRY_MS_ENV = 'CORAL_CURATE_TRANSIENT_RETRY_MS';
export const CORAL_CURATE_MISSING_CLI_RETRY_MS_ENV = 'CORAL_CURATE_MISSING_CLI_RETRY_MS';
export const CORAL_CURATE_MAX_RETRY_MS_ENV = 'CORAL_CURATE_MAX_RETRY_MS';

export type CurateTimings = {
  claimStaleMs: number;
  transientRetryMs: number;
  missingCliRetryMs: number;
  maxRetryMs: number;
};

const DEFAULT_CURATE_TIMINGS: CurateTimings = {
  claimStaleMs: DEFAULT_CLAIM_STALE_MS,
  transientRetryMs: DEFAULT_CURATE_TRANSIENT_RETRY_MS,
  missingCliRetryMs: DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
  maxRetryMs: DEFAULT_CURATE_MAX_RETRY_MS,
};

function parsePositiveIntMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolve curate timings from env. Each key independently honours its env
 * override when set to a positive integer; falls back to the default for
 * unset, blank, or malformed values.
 */
export function resolveCurateTimings(env: Pick<EnvPort, 'get'>): CurateTimings {
  return {
    claimStaleMs: parsePositiveIntMs(env.get(CORAL_CURATE_CLAIM_STALE_MS_ENV), DEFAULT_CLAIM_STALE_MS),
    transientRetryMs: parsePositiveIntMs(
      env.get(CORAL_CURATE_TRANSIENT_RETRY_MS_ENV),
      DEFAULT_CURATE_TRANSIENT_RETRY_MS,
    ),
    missingCliRetryMs: parsePositiveIntMs(
      env.get(CORAL_CURATE_MISSING_CLI_RETRY_MS_ENV),
      DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
    ),
    maxRetryMs: parsePositiveIntMs(env.get(CORAL_CURATE_MAX_RETRY_MS_ENV), DEFAULT_CURATE_MAX_RETRY_MS),
  };
}

/**
 * See `kb/curate/scheduler.ts` for the rationale narrative. Lives here
 * because the persisted `consecutive_*_failures` columns and the
 * `*_lane_disabled_at` stamps are part of the curate state model — the
 * cap is the policy that links the two, and pure reducers below need
 * the value to stamp `disabledAt` on the cap-trip.
 *
 * Design invariant — see spec §16 #54 and §3.1: this is part of the lane-disable
 * policy contract, NOT an operator knob. Changing it changes user-visible
 * behavior and invalidates the spec's reasoning about lane recovery.
 *
 * Exposed under the `INVARIANT.<name>` namespace per §16 #54 to mark it visually
 * distinct from operator knobs (which live alongside in the same file with
 * `CORAL_*` env override).
 */
export const INVARIANT = {
  MAX_CONSECUTIVE_FAILURES: 10,
} as const;

export type CurateCursor = {
  entrySeq: number;
  entryId: KbEntryId;
};

export type PendingRepair = {
  entrySeq: number | null;
  entryId: KbEntryId;
  detectedAt: string;
  observedContentHash?: string;
  reason?: string;
  locus?: string;
  canonicalIncident?: string;
  signalsJson?: string;
  repairHint?: string;
  retryNotBefore?: string;
  retryCount?: number;
};

export type PendingDiscovery = {
  principle: string;
  statement: string;
  notes: string[];
  createdAt: string;
  reason?: string;
};

export type CurateState = {
  processedThrough: CurateCursor | null;
  discoveryHighSeq: number;
  discoveryOffset: number;
  lastRunDay: string | null;
  lastAttemptedThrough: CurateCursor | null;
  retryNotBefore: string | null;
  activeClaim: {
    through: CurateCursor;
    startedAt: string;
  } | null;
  pendingDiscoveries: PendingDiscovery[];
  communityTopologyHash?: string;
  communitySummaryTopologyHash?: string;
  communitySummaryInputFingerprints?: Record<string, string>;
  consecutiveClaimFailures: number;
  consecutiveCommunityBatchFailures: number;
  /** ISO-8601 stamp when the claim lane first crossed `INVARIANT.MAX_CONSECUTIVE_FAILURES`; `null` while healthy. Cleared by `applyClearCurateRetryState`. */
  claimLaneDisabledAt: string | null;
  /** ISO-8601 stamp when the community-batch lane first crossed `INVARIANT.MAX_CONSECUTIVE_FAILURES`; `null` while healthy. Cleared by `applyClearCurateRetryState`. */
  communityBatchLaneDisabledAt: string | null;
  initialized: boolean;
};

export type CurateRepairFrontier =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | {
      kind: 'known';
      cursor: CurateCursor;
    };

export const kbEntryIdSchema = z.string().transform((value, ctx): KbEntryId => {
  const entryId = parseKbEntryId(value);
  if (entryId !== null) {
    return entryId;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'must be a KB entry ID',
  });
  return z.NEVER;
});

export function defaultCurateState(): CurateState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    communitySummaryInputFingerprints: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    initialized: false,
  };
}

export function compareCursor(left: CurateCursor, right: CurateCursor): number {
  if (left.entrySeq !== right.entrySeq) {
    return left.entrySeq - right.entrySeq;
  }

  return left.entryId.localeCompare(right.entryId);
}

export function noteCursor(note: string, entrySeq: number): CurateCursor {
  return {
    entryId: noteEntryId(note),
    entrySeq,
  };
}

export function cursorEntryKind(cursor: CurateCursor, label = 'curate'): 'note' | 'source' {
  if (cursor.entryId.startsWith('note:')) {
    return 'note';
  }
  if (cursor.entryId.startsWith('source:')) {
    return 'source';
  }

  throw new Error(`${label} cursor must point at a note or source entry: ${cursor.entryId}`);
}

export function compareOptionalCursor(left: CurateCursor | null, right: CurateCursor): number {
  if (left === null) {
    return -1;
  }

  return compareCursor(left, right);
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function retryBaseCooldownMs(error: unknown, timings: CurateTimings): number {
  const message = errorMessage(error);
  if (message.includes('Failed to spawn claude:') && (message.includes('ENOENT') || message.includes('not found'))) {
    return timings.missingCliRetryMs;
  }

  return timings.transientRetryMs;
}

function calculateRetryCooldownMs(
  baseCooldownMs: number,
  consecutiveClaimFailures: number,
  maxRetryMs: number,
): number {
  return Math.min(baseCooldownMs * 2 ** consecutiveClaimFailures, maxRetryMs);
}

export function applyRecordCurateFailure(
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
  nowMs: number,
  timings: CurateTimings = DEFAULT_CURATE_TIMINGS,
): CurateState | null {
  const attemptedThrough = through ?? state.lastAttemptedThrough;
  if (attemptedThrough === null) {
    if (state.activeClaim === null) {
      return null;
    }

    return {
      ...state,
      activeClaim: null,
    };
  }

  const sameAttempt =
    state.lastAttemptedThrough !== null && compareCursor(state.lastAttemptedThrough, attemptedThrough) === 0;
  const priorFailures = sameAttempt ? state.consecutiveClaimFailures : 0;
  const nextFailures = priorFailures + 1;
  // Stamp the disabled-at marker on the *transition* from healthy to disabled
  // (`< cap` → `>= cap`); leave any prior stamp intact across the boundary so
  // operators see the moment the lane first tripped, not the most recent retry.
  const tripped = nextFailures >= INVARIANT.MAX_CONSECUTIVE_FAILURES && state.claimLaneDisabledAt === null;

  return {
    ...state,
    lastAttemptedThrough: attemptedThrough,
    retryNotBefore: nowIsoString(
      nowMs + calculateRetryCooldownMs(retryBaseCooldownMs(error, timings), priorFailures, timings.maxRetryMs),
    ),
    activeClaim: null,
    consecutiveClaimFailures: nextFailures,
    claimLaneDisabledAt: tripped ? nowIsoString(nowMs) : state.claimLaneDisabledAt,
  };
}

export function applyClearCurateRetryState(state: CurateState): CurateState | null {
  if (
    state.activeClaim === null &&
    state.retryNotBefore === null &&
    state.consecutiveClaimFailures === 0 &&
    state.consecutiveCommunityBatchFailures === 0 &&
    state.claimLaneDisabledAt === null &&
    state.communityBatchLaneDisabledAt === null
  ) {
    return null;
  }

  return {
    ...state,
    retryNotBefore: null,
    activeClaim: null,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
  };
}

export function applyRecordDiscoveryAttempt(state: CurateState, highSeq: number, nextOffset: number): CurateState {
  return {
    ...state,
    discoveryHighSeq: Math.max(state.discoveryHighSeq, highSeq),
    discoveryOffset: nextOffset,
  };
}

function samePendingDiscovery(left: PendingDiscovery, right: PendingDiscovery): boolean {
  return left.principle === right.principle && left.statement === right.statement;
}

export function applyAddPendingDiscovery(state: CurateState, entry: PendingDiscovery): CurateState | null {
  if (state.pendingDiscoveries.some((pending) => samePendingDiscovery(pending, entry))) {
    return null;
  }

  return {
    ...state,
    pendingDiscoveries: [...state.pendingDiscoveries, entry],
  };
}

export function applyRemovePendingDiscovery(state: CurateState, entry: PendingDiscovery): CurateState | null {
  const nextPendingDiscoveries = state.pendingDiscoveries.filter((pending) => !samePendingDiscovery(pending, entry));
  if (nextPendingDiscoveries.length === state.pendingDiscoveries.length) {
    return null;
  }

  return {
    ...state,
    pendingDiscoveries: nextPendingDiscoveries,
  };
}

export function isClaimStale(state: CurateState, now: string, claimStaleMs: number = DEFAULT_CLAIM_STALE_MS): boolean {
  if (state.activeClaim === null) {
    return false;
  }

  const startedAt = Date.parse(state.activeClaim.startedAt);
  if (Number.isNaN(startedAt)) {
    return true;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return false;
  }

  return nowMs - startedAt >= claimStaleMs;
}
