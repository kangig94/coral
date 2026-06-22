import { nowIsoString } from '../../infra/time.js';
import type { KbRuntime } from '../contract.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type CuratableEntry,
  type KbEntryId,
  type KbIndex,
} from '../entry-types.js';
import {
  buildClassificationPrompt,
  buildPrincipleNames,
  takeClassificationBatchWithIndex,
} from './classification/prompt.js';
import { mergeAssignmentsIntoIndexGraph, validateAssignments } from './classification/assignments.js';
import { parseClassificationResponseResult } from './classification/parse.js';
import { readClaimedEntry } from './claim-io.js';
import { filterCandidatesBeforeRepairFrontier } from './metadata-commit.js';
import { CurateJsonParseError, runCurateAssistant } from './operations.js';
import {
  compareCursor,
  getCurateRepairFrontier,
  isClaimStale,
  noteCursor,
  readCurateState,
  resolveCurateTimings,
  sourceCursor,
  writeCurateState,
  type CurateCursor,
} from './state/index.js';
import type { ClaimCandidate, ClassificationAssignment, CurateClaim, CurateClaimedEntry } from './pipeline-types.js';
import type { CurateAssistantPort } from './assistant.js';
import { curateDb } from './db-access.js';
import { deleteCurateConflictQuarantineEntry, readCurateConflictQuarantine } from './conflict-quarantine.js';

const CURATE_MIN_CLAIM_SIZE = 10;
const CURATE_IMMEDIATE_CLAIM_SIZE = 30;
const CURATE_MAX_CLAIM_SIZE = 100;
const CLASSIFICATION_BATCH_SIZE = 100;

function getCuratableEntries(index: KbIndex): CuratableEntry[] {
  const entries: CuratableEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isNoteEntry(entry) || isSourceEntry(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

function compareCursorDates(target: string | null, now: string): number {
  if (target === null) {
    return Number.NEGATIVE_INFINITY;
  }

  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  return targetMs - nowMs;
}

function classificationPending(entry: CuratableEntry): boolean {
  return entry.inputFingerprint === undefined || entry.inputFingerprint !== entry.bodyHash;
}

function hasCursorTimestamp(timestamp: string): boolean {
  return timestamp.trim().length > 0 && !Number.isNaN(Date.parse(timestamp));
}

function collectClaimCandidates(
  index: KbIndex,
  quarantinedEntries: ReadonlySet<KbEntryId> = new Set(),
): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];
  for (const entry of getCuratableEntries(index)) {
    const entryId = isNoteEntry(entry) ? noteEntryId(entry.slug) : sourceEntryId(entry.slug);
    if (quarantinedEntries.has(entryId)) {
      continue;
    }

    if (!classificationPending(entry)) {
      continue;
    }

    if (isNoteEntry(entry)) {
      if (!hasCursorTimestamp(entry.createdAt)) {
        continue;
      }
      candidates.push({
        kind: 'note',
        entryId,
        slug: entry.slug,
        updatedAt: entry.updatedAt,
        ...(entry.entrySeq === undefined ? {} : { entrySeq: entry.entrySeq }),
        cursor: noteCursor(entry.slug, entry.createdAt),
      });
      continue;
    }

    if (!hasCursorTimestamp(entry.importedAt)) {
      continue;
    }
    candidates.push({
      kind: 'source',
      entryId,
      slug: entry.slug,
      ...(entry.entrySeq === undefined ? {} : { entrySeq: entry.entrySeq }),
      cursor: sourceCursor(entry.slug, entry.importedAt),
    });
  }

  return candidates.sort((left, right) => compareCursor(left.cursor, right.cursor));
}

function activeClassificationQuarantine(db: ReturnType<typeof curateDb>, index: KbIndex): Set<KbEntryId> {
  const quarantinedEntries = new Set<KbEntryId>();
  for (const quarantine of readCurateConflictQuarantine(db)) {
    const entry = index.entries[quarantine.entryId];
    if (entry === undefined) {
      deleteCurateConflictQuarantineEntry(db, quarantine.entryId);
      continue;
    }
    if (isNoteEntry(entry) || isSourceEntry(entry)) {
      if (!classificationPending(entry)) {
        deleteCurateConflictQuarantineEntry(db, quarantine.entryId);
        continue;
      }
      quarantinedEntries.add(quarantine.entryId);
    }
  }
  return quarantinedEntries;
}

function pendingExtendsBeyondCursor(pendingEntries: ClaimCandidate[], cursor: CurateCursor | null): boolean {
  if (cursor === null || pendingEntries.length === 0) {
    return false;
  }

  return compareCursor(pendingEntries[pendingEntries.length - 1].cursor, cursor) > 0;
}

export async function claimCurateRun(kb: KbRuntime, today: string): Promise<CurateClaim | null> {
  const lockResult = await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    const now = nowIsoString(kb.time);

    if (state.activeClaim !== null && !isClaimStale(state, now, resolveCurateTimings(kb.envPort).claimStaleMs)) {
      return null;
    }

    const index = kb.readIndex();
    if (index === null) {
      return null;
    }

    const db = curateDb(kb);
    const repairFrontier = getCurateRepairFrontier(db);
    const quarantinedEntries = activeClassificationQuarantine(db, index);
    const pendingEntries = filterCandidatesBeforeRepairFrontier(
      collectClaimCandidates(index, quarantinedEntries),
      repairFrontier,
    );
    if (pendingEntries.length === 0) {
      return null;
    }

    const firstPassClaim =
      (today !== state.lastRunDay && pendingEntries.length >= CURATE_MIN_CLAIM_SIZE) ||
      pendingEntries.length >= CURATE_IMMEDIATE_CLAIM_SIZE;
    const retryBlocked =
      compareCursorDates(state.retryNotBefore, now) > 0 &&
      !pendingExtendsBeyondCursor(pendingEntries, state.lastAttemptedThrough);
    const retryClaim = state.lastAttemptedThrough !== null && state.retryNotBefore !== null && !retryBlocked;

    if (!firstPassClaim && !retryClaim) {
      return null;
    }

    const claimedCandidates = pendingEntries.slice(0, CURATE_MAX_CLAIM_SIZE);
    const through = claimedCandidates[claimedCandidates.length - 1]?.cursor;
    if (through === undefined) {
      return null;
    }

    const freshPendingSuffix = pendingExtendsBeyondCursor(pendingEntries, state.lastAttemptedThrough);
    writeCurateState(curateDb(kb), {
      ...state,
      retryNotBefore: null,
      activeClaim: {
        through,
        startedAt: now,
      },
      lastAttemptedThrough: through,
      consecutiveClaimFailures: freshPendingSuffix ? 0 : state.consecutiveClaimFailures,
      // Reset the lane-disabled stamp alongside the counter on a fresh suffix —
      // moving past the wedge-causing cursor is what re-enables the lane.
      claimLaneDisabledAt: freshPendingSuffix ? null : state.claimLaneDisabledAt,
      ...(firstPassClaim ? { lastRunDay: today } : {}),
    });

    return { claimedCandidates, through };
  });

  if (lockResult === null) {
    return null;
  }

  const entries: CurateClaimedEntry[] = [];
  for (const candidate of lockResult.claimedCandidates) {
    try {
      entries.push(readClaimedEntry(kb, candidate));
    } catch {
      // Skip candidates that disappeared or became unreadable after claiming.
    }
  }
  if (entries.length === 0) {
    return null;
  }

  return { entries, through: lockResult.through };
}

export async function runClassificationBatches(
  kb: KbRuntime,
  curateAssistant: CurateAssistantPort,
  claim: CurateClaim,
  index: KbIndex,
  signal?: AbortSignal,
): Promise<ClassificationAssignment[]> {
  let workingGraphIndex = index;
  const validatedAssignments: ClassificationAssignment[] = [];
  const principleNames = buildPrincipleNames(index);
  const remainingEntries = [...claim.entries];

  while (remainingEntries.length > 0) {
    const { batch, vocabulary } = takeClassificationBatchWithIndex(
      remainingEntries,
      workingGraphIndex,
      principleNames,
      CLASSIFICATION_BATCH_SIZE,
    );
    if (batch.length === 0) {
      throw new Error('Classification batch selection produced an empty batch.');
    }

    const prompt = buildClassificationPrompt(batch, vocabulary, principleNames);
    const raw = await runCurateAssistant(curateAssistant, prompt, 'classification', signal);
    const entryMap = new Map<string, true>();
    for (const entry of batch) {
      entryMap.set(entry.entryId, true);
    }
    const parsed = parseClassificationResponseResult(raw, entryMap);
    if (parsed.parseFailed) {
      throw new CurateJsonParseError('classification');
    }

    const validatedBatch = validateAssignments(parsed.assignments, workingGraphIndex, batch);
    validatedAssignments.push(...validatedBatch);
    workingGraphIndex = mergeAssignmentsIntoIndexGraph(workingGraphIndex, validatedBatch);
    remainingEntries.splice(0, batch.length);
  }

  return validatedAssignments;
}

export async function hasPendingEntriesBeyondCursor(kb: KbRuntime, cursor: CurateCursor): Promise<boolean> {
  return kb.withMutationLock(() => {
    const index = kb.readIndex();
    if (index === null) {
      return false;
    }

    const db = curateDb(kb);
    const repairFrontier = getCurateRepairFrontier(db);
    const quarantinedEntries = activeClassificationQuarantine(db, index);
    for (const candidate of filterCandidatesBeforeRepairFrontier(
      collectClaimCandidates(index, quarantinedEntries),
      repairFrontier,
    )) {
      if (compareCursor(candidate.cursor, cursor) > 0) {
        return true;
      }
    }
    return false;
  });
}
