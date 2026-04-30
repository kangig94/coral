import { nowIsoString } from '../../infra/time.js';
import type { KbRuntime } from '../contract.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type CuratableEntry,
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
import { CurateJsonParseError, runCurateClaude } from './operations.js';
import {
  compareCursor,
  compareOptionalCursor,
  getCurateRepairFrontier,
  isClaimStale,
  noteCursor,
  readCurateState,
  resolveCurateTimings,
  writeCurateState,
  type CurateCursor,
} from './state/index.js';
import type { ClaimCandidate, ClassificationAssignment, CurateClaim, SpawnCliFn } from './pipeline-types.js';

const CURATE_MIN_CLAIM_SIZE = 10;
const CURATE_IMMEDIATE_CLAIM_SIZE = 30;
const CURATE_MAX_CLAIM_SIZE = 100;
const CLASSIFICATION_BATCH_SIZE = 100;

function getCuratableEntries(index: KbIndex): CuratableEntry[] {
  return Object.values(index.entries).filter(
    (entry): entry is CuratableEntry => isNoteEntry(entry) || isSourceEntry(entry),
  );
}

function sourceCursor(slug: string, entrySeq: number): CurateCursor {
  return {
    entryId: sourceEntryId(slug),
    entrySeq,
  };
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

function collectClaimCandidates(index: KbIndex): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];
  for (const entry of getCuratableEntries(index)) {
    if (entry.entrySeq === undefined) {
      continue;
    }

    if (isNoteEntry(entry)) {
      candidates.push({
        kind: 'note',
        entryId: noteEntryId(entry.slug),
        slug: entry.slug,
        updatedAt: entry.updatedAt,
        cursor: noteCursor(entry.slug, entry.entrySeq),
      });
      continue;
    }

    candidates.push({
      kind: 'source',
      entryId: sourceEntryId(entry.slug),
      slug: entry.slug,
      cursor: sourceCursor(entry.slug, entry.entrySeq),
    });
  }

  return candidates.sort((left, right) => compareCursor(left.cursor, right.cursor));
}

function pendingExtendsBeyondCursor(pendingEntries: ClaimCandidate[], cursor: CurateCursor | null): boolean {
  if (cursor === null || pendingEntries.length === 0) {
    return false;
  }

  return compareCursor(pendingEntries[pendingEntries.length - 1].cursor, cursor) > 0;
}

export async function claimCurateRun(kb: KbRuntime, today: string): Promise<CurateClaim | null> {
  const lockResult = await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    const now = nowIsoString(kb.time);

    if (state.activeClaim !== null && !isClaimStale(state, now, resolveCurateTimings(kb.envPort).claimStaleMs)) {
      return null;
    }

    const index = kb.readIndex();
    if (index === null) {
      return null;
    }

    const repairFrontier = getCurateRepairFrontier(kb);
    const pendingEntries = filterCandidatesBeforeRepairFrontier(
      collectClaimCandidates(index).filter(
        (candidate) => compareOptionalCursor(state.processedThrough, candidate.cursor) < 0,
      ),
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
    writeCurateState(kb, {
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

  const entries = lockResult.claimedCandidates.flatMap((candidate) => {
    try {
      return [readClaimedEntry(kb, candidate)];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) {
    return null;
  }

  return { entries, through: lockResult.through };
}

export async function runClassificationBatches(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
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
    const raw = await runCurateClaude(kb, spawnCli, prompt, undefined, signal);
    const entryMap = new Map<string, true>(batch.map((entry) => [entry.entryId, true] as const));
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

    const repairFrontier = getCurateRepairFrontier(kb);
    return filterCandidatesBeforeRepairFrontier(collectClaimCandidates(index), repairFrontier).some(
      (candidate) => compareCursor(candidate.cursor, cursor) > 0,
    );
  });
}
