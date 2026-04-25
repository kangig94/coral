import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { errorMessage } from '../../../infra/error-format.js';
import { SYSTEM_TIME_PORT, nowIsoString } from '../../../infra/time.js';
import {
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbEntryId,
} from '../../entry-types.js';

const CLAIM_STALE_MS = 15 * 60 * 1000;
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;
const LENIENT_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)(?:\r?\n---(?:\r?\n|$)|$)/;
const LENIENT_ENTRY_SEQ_PATTERN = /(?:^|\r?\n)\s*entrySeq:\s*(?:['"])?(\d+)(?:['"])?\s*(?:#.*)?(?=\r?\n|$)/;

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
  pendingRepair: PendingRepair[] | null;
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
    pendingRepair: null,
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    communitySummaryInputFingerprints: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    initialized: false,
  };
}

export function resetCurateStateForBackfill(state: CurateState): CurateState {
  return normalizeCurateStateRepairFrontier({
    ...state,
    processedThrough: null,
    activeClaim: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    lastRunDay: null,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
  });
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

function comparePendingRepair(left: PendingRepair, right: PendingRepair): number {
  if (left.entrySeq === null || right.entrySeq === null) {
    if (left.entrySeq === null && right.entrySeq === null) {
      return left.entryId.localeCompare(right.entryId);
    }

    return left.entrySeq === null ? -1 : 1;
  }

  return compareCursor(
    {
      entryId: left.entryId,
      entrySeq: left.entrySeq,
    },
    {
      entryId: right.entryId,
      entrySeq: right.entrySeq,
    },
  );
}

function effectivePendingRepair(pendingRepair: CurateState['pendingRepair']): PendingRepair[] | null {
  if (pendingRepair === null || pendingRepair.length === 0) {
    return null;
  }

  return [...pendingRepair].sort(comparePendingRepair);
}

export function getCurateRepairFrontier(pendingRepair: CurateState['pendingRepair']): CurateRepairFrontier {
  const normalizedPendingRepair = effectivePendingRepair(pendingRepair);
  if (normalizedPendingRepair === null) {
    return { kind: 'none' };
  }

  if (normalizedPendingRepair.some((entry) => entry.entrySeq === null)) {
    return { kind: 'unknown' };
  }

  const first = normalizedPendingRepair[0];
  if (first === undefined || first.entrySeq === null) {
    return { kind: 'none' };
  }

  return {
    kind: 'known',
    cursor: {
      entryId: first.entryId,
      entrySeq: first.entrySeq,
    },
  };
}

function clampCursorToRepairFrontier(cursor: CurateCursor | null, frontier: CurateRepairFrontier): CurateCursor | null {
  if (cursor === null || frontier.kind === 'none') {
    return cursor;
  }
  if (frontier.kind === 'unknown') {
    return null;
  }

  return compareCursor(cursor, frontier.cursor) >= 0 ? null : cursor;
}

export function normalizeCurateStateRepairFrontier(state: CurateState): CurateState {
  const pendingRepair = effectivePendingRepair(state.pendingRepair);
  const frontier = getCurateRepairFrontier(pendingRepair);

  if (frontier.kind === 'unknown') {
    return {
      ...state,
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      pendingRepair,
    };
  }

  if (frontier.kind === 'known' && state.discoveryHighSeq >= frontier.cursor.entrySeq) {
    return {
      ...state,
      processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
      lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
      discoveryHighSeq: Math.max(frontier.cursor.entrySeq - 1, 0),
      discoveryOffset: 0,
      pendingRepair,
    };
  }

  return {
    ...state,
    processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
    lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
    pendingRepair,
  };
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

type MalformedEntryKind = 'note' | 'source';

function extractLenientFrontmatterRegion(content: string): string {
  const match = content.match(LENIENT_FRONTMATTER_PATTERN);
  if (match !== null) {
    return match[1];
  }

  if (!content.startsWith('---')) {
    return content.slice(0, 2048);
  }

  return content.slice(4, 2048);
}

function extractLenientEntrySeq(content: string): number | null {
  const match = extractLenientFrontmatterRegion(content).match(LENIENT_ENTRY_SEQ_PATTERN);
  if (match === null) {
    return null;
  }

  const entrySeq = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(entrySeq) || entrySeq < 1) {
    return null;
  }

  return entrySeq;
}

function parseMalformedEntryId(kind: MalformedEntryKind, slug: string): KbEntryId | null {
  return parseKbEntryId(kind === 'note' ? noteEntryId(slug) : sourceEntryId(slug));
}

function hashObservedContent(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function extractMalformedEntryRepair(
  kind: MalformedEntryKind,
  slug: string,
  raw: string,
  detectedAt: string,
): PendingRepair | null {
  const entryId = parseMalformedEntryId(kind, slug);
  if (entryId === null) {
    return null;
  }

  return {
    entryId,
    entrySeq: extractLenientEntrySeq(raw),
    detectedAt,
  };
}

export function readMalformedEntryRepair(
  path: string,
  kind: MalformedEntryKind,
  slug: string,
  detectedAt: string,
): PendingRepair | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const repair = extractMalformedEntryRepair(kind, slug, raw, detectedAt);
    if (repair === null) {
      return null;
    }

    return {
      ...repair,
      observedContentHash: hashObservedContent(raw),
    };
  } catch {
    return null;
  }
}
