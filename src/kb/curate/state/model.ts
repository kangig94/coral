import { z } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import { nowIsoString } from '../../../infra/time.js';
import type { EnvPort } from '../../../infra/port-types.js';
import { noteEntryId, parseKbEntryId, sourceEntryId, type KbEntryId } from '../../entry-types.js';

/**
 * Curate timing operator knobs (see §16(d) triage rule). Defaults match the
 * historical hardcoded values; operators tune via the matching `CORAL_KB_CURATE_*`
 * env vars. Reducers below stay pure — they receive the resolved timings as
 * parameters; the env read happens at the scheduler/operations boundary.
 */
export const DEFAULT_CLAIM_STALE_MS = 15 * 60 * 1000;
export const DEFAULT_CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
export const DEFAULT_CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;

export const CORAL_KB_CURATE_CLAIM_STALE_MS_ENV = 'CORAL_KB_CURATE_CLAIM_STALE_MS';
export const CORAL_KB_CURATE_TRANSIENT_RETRY_MS_ENV = 'CORAL_KB_CURATE_TRANSIENT_RETRY_MS';
export const CORAL_KB_CURATE_MISSING_CLI_RETRY_MS_ENV = 'CORAL_KB_CURATE_MISSING_CLI_RETRY_MS';
export const CORAL_KB_CURATE_MAX_RETRY_MS_ENV = 'CORAL_KB_CURATE_MAX_RETRY_MS';

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
    claimStaleMs: parsePositiveIntMs(env.get(CORAL_KB_CURATE_CLAIM_STALE_MS_ENV), DEFAULT_CLAIM_STALE_MS),
    transientRetryMs: parsePositiveIntMs(
      env.get(CORAL_KB_CURATE_TRANSIENT_RETRY_MS_ENV),
      DEFAULT_CURATE_TRANSIENT_RETRY_MS,
    ),
    missingCliRetryMs: parsePositiveIntMs(
      env.get(CORAL_KB_CURATE_MISSING_CLI_RETRY_MS_ENV),
      DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
    ),
    maxRetryMs: parsePositiveIntMs(env.get(CORAL_KB_CURATE_MAX_RETRY_MS_ENV), DEFAULT_CURATE_MAX_RETRY_MS),
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

export type CurateCursorKind = 'note' | 'source';

export type CurateCursor = {
  timestamp: string;
  kind: CurateCursorKind;
  slug: string;
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
  communitySummaryTopologyHash?: string;
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
      entryId: KbEntryId;
      entrySeq: number;
    };

export const kbEntryIdSchema = z
  .string()
  .transform((value, ctx): KbEntryId => {
    const entryId = parseKbEntryId(value);
    if (entryId !== null) {
      return entryId;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a KB entry ID',
    });
    return z.NEVER;
  })
  .describe('parse-kb-entry-id');

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
    communitySummaryTopologyHash: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    initialized: false,
  };
}

export function compareCursor(left: CurateCursor, right: CurateCursor): number {
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }

  const timestampOrder = left.timestamp.localeCompare(right.timestamp);
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) {
    return kindOrder;
  }

  return left.slug.localeCompare(right.slug);
}

export function noteCursor(note: string, timestamp: string): CurateCursor {
  return {
    timestamp,
    kind: 'note',
    slug: note,
  };
}

export function sourceCursor(slug: string, timestamp: string): CurateCursor {
  return {
    timestamp,
    kind: 'source',
    slug,
  };
}

export function cursorEntryId(cursor: CurateCursor): KbEntryId {
  return cursor.kind === 'note' ? noteEntryId(cursor.slug) : sourceEntryId(cursor.slug);
}

export function cursorEntryKind(cursor: CurateCursor, _label = 'curate'): CurateCursorKind {
  return cursor.kind;
}

export function cursorFromEntryId(timestamp: string, entryId: KbEntryId, label = 'curate'): CurateCursor {
  const parsed = parseKbEntryId(entryId);
  if (parsed === null || (!parsed.startsWith('note:') && !parsed.startsWith('source:'))) {
    throw new Error(`${label} cursor must point at a note or source entry: ${entryId}`);
  }

  if (parsed.startsWith('note:')) {
    return noteCursor(parsed.slice('note:'.length), timestamp);
  }
  return sourceCursor(parsed.slice('source:'.length), timestamp);
}

export function cursorTimestampToStorageSeq(cursor: CurateCursor, label = 'curate'): number {
  const timestampMs = Date.parse(cursor.timestamp);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error(`${label} cursor timestamp must be a parseable positive timestamp: ${cursor.timestamp}`);
  }
  return timestampMs;
}

export function cursorTimestampFromStorageSeq(value: number): string {
  return nowIsoString(value);
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

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
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

export function applyClearCurateClaimRetryState(state: CurateState): CurateState | null {
  if (
    state.activeClaim === null &&
    state.retryNotBefore === null &&
    state.consecutiveClaimFailures === 0 &&
    state.claimLaneDisabledAt === null
  ) {
    return null;
  }

  return {
    ...state,
    retryNotBefore: null,
    activeClaim: null,
    consecutiveClaimFailures: 0,
    claimLaneDisabledAt: null,
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
  for (const pending of state.pendingDiscoveries) {
    if (samePendingDiscovery(pending, entry)) {
      return null;
    }
  }

  return {
    ...state,
    pendingDiscoveries: [...state.pendingDiscoveries, entry],
  };
}

export function applyRemovePendingDiscovery(state: CurateState, entry: PendingDiscovery): CurateState | null {
  const nextPendingDiscoveries: PendingDiscovery[] = [];
  for (const pending of state.pendingDiscoveries) {
    if (!samePendingDiscovery(pending, entry)) {
      nextPendingDiscoveries.push(pending);
    }
  }
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
