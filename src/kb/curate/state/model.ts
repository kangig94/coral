import { z } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import { SYSTEM_TIME_PORT, nowIsoString } from '../../../infra/time.js';
import {
  noteEntryId,
  parseKbEntryId,
  type KbEntryId,
} from '../../entry-types.js';

const CLAIM_STALE_MS = 15 * 60 * 1000;
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;

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

function retryBaseCooldownMs(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes('Failed to spawn claude:') && (message.includes('ENOENT') || message.includes('not found'))) {
    return CURATE_MISSING_CLI_RETRY_MS;
  }

  return CURATE_TRANSIENT_RETRY_MS;
}

function calculateRetryCooldownMs(baseCooldownMs: number, consecutiveClaimFailures: number): number {
  return Math.min(baseCooldownMs * 2 ** consecutiveClaimFailures, CURATE_MAX_RETRY_MS);
}

export function applyRecordCurateFailure(
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
  nowMs: number = SYSTEM_TIME_PORT.now(),
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

  return {
    ...state,
    lastAttemptedThrough: attemptedThrough,
    retryNotBefore: nowIsoString(nowMs + calculateRetryCooldownMs(retryBaseCooldownMs(error), priorFailures)),
    activeClaim: null,
    consecutiveClaimFailures: priorFailures + 1,
  };
}

export function applyClearCurateRetryState(state: CurateState): CurateState | null {
  if (state.activeClaim === null && state.retryNotBefore === null && state.consecutiveClaimFailures === 0) {
    return null;
  }

  return {
    ...state,
    retryNotBefore: null,
    activeClaim: null,
    consecutiveClaimFailures: 0,
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

export function isClaimStale(state: CurateState, now: string): boolean {
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

  return nowMs - startedAt >= CLAIM_STALE_MS;
}

