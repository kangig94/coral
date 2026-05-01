import { isNoEntryError, unlinkIfExists } from '../../infra/fs-errors.js';
import { nowIsoString } from '../../infra/time.js';
import type { KbMutationEffects, KbRuntime } from '../contract.js';
import { capturePrincipleManifestDelta, captureRemovedPrincipleManifestDelta } from '../corpus/manifest-authority.js';
import { extractPrincipleStatement } from '../corpus/frontmatter.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { markTextIndexStale, recordMetadataMutation } from '../corpus/index-mutations.js';
import { cloneKbIndex } from '../corpus/index-records.js';
import { assertNonEmptyText, assertNoteSlug } from '../validation.js';
import { getEntry, isNoteEntry, noteEntryId, type KbIndex, type NoteEntry } from '../entry-types.js';
import { readClaimedEntry } from './claim-io.js';
import {
  buildDiscoveryPrompt,
  parseDiscoveryResponseResult,
  prepareDiscoveryBatch,
  sameDiscoverySelection,
  serializePrincipleDocument,
  validateDiscoveryProposals,
} from './discovery.js';
import {
  commitMetadataTargetsLocked,
  compareMetadataTarget,
  cursorFromTarget,
  filterCandidatesBeforeRepairFrontier,
  isCursorBeforeRepairFrontier,
} from './metadata-commit.js';
import { CURATE_STALE_REASON, persistCurateState, runCurateClaude, CurateJsonParseError } from './operations.js';
import {
  applyAddPendingDiscovery,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  getCurateRepairFrontier,
  noteCursor,
  readCurateState,
  type CurateCursor,
  type CurateState,
  type PendingDiscovery,
} from './state/index.js';
import type { DiscoveryCurateClaimedEntry, MetadataTarget, NoteClaimCandidate } from './pipeline-types.js';
import type { SpawnCliFn } from './spawn-cli.js';
import { curateDb } from './db-access.js';

type EnsurePrincipleDocumentResult = {
  status: 'ready' | 'conflict';
  state: CurateState;
};

type RunPrincipleDiscoveryOptions = {
  signal?: AbortSignal;
  schedule?: () => void;
};

function getIndexNote(index: KbIndex, note: string): NoteEntry | undefined {
  const entry = getEntry(index, noteEntryId(note));
  return entry !== undefined && isNoteEntry(entry) ? entry : undefined;
}

function buildPrincipleAssignmentTargets(
  principle: string,
  notes: string[],
  index: KbIndex,
  processedThrough: CurateCursor,
): MetadataTarget[] {
  const targets: MetadataTarget[] = [];

  for (const note of notes) {
    const noteMeta = getIndexNote(index, note);
    if (noteMeta === undefined || noteMeta.entrySeq === undefined) {
      continue;
    }

    const cursor = noteCursor(note, noteMeta.entrySeq);
    if (compareCursor(cursor, processedThrough) > 0 || noteMeta.principles.includes(principle)) {
      continue;
    }

    targets.push({
      kind: 'note',
      entryId: noteEntryId(note),
      slug: note,
      entrySeq: noteMeta.entrySeq,
      claimTimeUpdatedAt: noteMeta.updatedAt,
      addPrinciples: [principle],
    });
  }

  return targets.sort(compareMetadataTarget);
}

function loadEligibleDiscoveryNotes(kb: KbRuntime, candidates: NoteClaimCandidate[]): DiscoveryCurateClaimedEntry[] {
  const eligible: DiscoveryCurateClaimedEntry[] = [];

  for (const candidate of candidates) {
    try {
      const entry = readClaimedEntry(kb, candidate);
      if (entry.kind === 'note') {
        eligible.push(entry);
      }
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        continue;
      }
      throw error;
    }
  }

  return eligible;
}

export function recordDiscoveryAttemptLocked(
  kb: KbRuntime,
  state: CurateState,
  highSeq: number,
  nextOffset: number,
): CurateState {
  return persistCurateState(kb, state, applyRecordDiscoveryAttempt(state, highSeq, nextOffset));
}

export async function recordDiscoveryAttempt(kb: KbRuntime, highSeq: number, nextOffset: number): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    recordDiscoveryAttemptLocked(kb, state, highSeq, nextOffset);
  });
}

export function addPendingDiscoveryLocked(kb: KbRuntime, state: CurateState, entry: PendingDiscovery): CurateState {
  return persistCurateState(kb, state, applyAddPendingDiscovery(state, entry));
}

export async function addPendingDiscovery(kb: KbRuntime, entry: PendingDiscovery): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    addPendingDiscoveryLocked(kb, state, entry);
  });
}

export function removePendingDiscoveryLocked(kb: KbRuntime, state: CurateState, entry: PendingDiscovery): CurateState {
  return persistCurateState(kb, state, applyRemovePendingDiscovery(state, entry));
}

export async function removePendingDiscovery(kb: KbRuntime, entry: PendingDiscovery): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    removePendingDiscoveryLocked(kb, state, entry);
  });
}

function ensurePrincipleDocumentLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  entry: PendingDiscovery,
  state: CurateState,
): EnsurePrincipleDocumentResult {
  const principlePath = kb.principlePath(assertNoteSlug(entry.principle, 'principle'));
  const nextIndex = cloneKbIndex(kb.readIndex());

  try {
    const liveStatement = extractPrincipleStatement(kb.storagePort.readFileSync(principlePath, 'utf-8'));
    if (liveStatement !== entry.statement) {
      return { status: 'conflict', state };
    }

    if (nextIndex.principles[entry.principle] !== entry.statement) {
      nextIndex.principles[entry.principle] = entry.statement;
      kb.writeIndex(nextIndex);
      markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);
    }

    return { status: 'ready', state };
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      return { status: 'conflict', state };
    }
  }

  recordMetadataMutation(kb, CURATE_STALE_REASON);
  const principleDocument = serializePrincipleDocument(entry.statement, entry.createdAt);
  writeFileAtomic(kb, principlePath, principleDocument);
  mutation.queueManifestAuthorityDelta(capturePrincipleManifestDelta(entry.principle, principleDocument));
  nextIndex.principles[entry.principle] = entry.statement;
  kb.writeIndex(nextIndex);
  return {
    status: 'ready',
    state,
  };
}

function pendingDiscoverySatisfied(kb: KbRuntime, entry: PendingDiscovery, processedThrough: CurateCursor): boolean {
  const index = kb.readIndexOrEmpty();

  return entry.notes.every((note) => {
    const noteMeta = getIndexNote(index, note);
    if (noteMeta === undefined) {
      return true;
    }
    if (noteMeta.entrySeq === undefined) {
      return false;
    }
    if (compareCursor(noteCursor(note, noteMeta.entrySeq), processedThrough) > 0) {
      return false;
    }

    return noteMeta.principles.includes(entry.principle);
  });
}

async function drainPendingDiscoveries(kb: KbRuntime, processedThrough: CurateCursor): Promise<void> {
  await kb.withMutationLock(async (mutation) => {
    let state = readCurateState(curateDb(kb));
    const pendingDiscoveries = state.pendingDiscoveries;

    for (const entry of pendingDiscoveries) {
      const principleDocument = ensurePrincipleDocumentLocked(kb, mutation, entry, state);
      state = principleDocument.state;

      if (principleDocument.status === 'conflict') {
        state = removePendingDiscoveryLocked(kb, state, entry);
        continue;
      }

      const targets = buildPrincipleAssignmentTargets(
        entry.principle,
        entry.notes,
        kb.readIndexOrEmpty(),
        processedThrough,
      );
      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, mutation, targets, state);
      }

      if (pendingDiscoverySatisfied(kb, entry, processedThrough)) {
        state = removePendingDiscoveryLocked(kb, state, entry);
      }
    }
  });
}

export async function runPrincipleDiscovery(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  processedThrough: CurateCursor,
  options: RunPrincipleDiscoveryOptions = {},
): Promise<void> {
  const { signal, schedule } = options;
  await drainPendingDiscoveries(kb, processedThrough);

  const currentIndex = kb.readIndexOrEmpty();
  const preparedBatch = prepareDiscoveryBatch(curateDb(kb),currentIndex, readCurateState(curateDb(kb)), processedThrough);
  if (preparedBatch === null) {
    return;
  }

  const batch = preparedBatch.batch;
  const eligibleNotes = loadEligibleDiscoveryNotes(kb, batch.selected);

  const { prompt, corpusPath } = buildDiscoveryPrompt(kb, eligibleNotes, currentIndex.principles);
  let raw: string;
  try {
    raw = await runCurateClaude(kb, spawnCli, prompt, undefined, signal);
  } finally {
    unlinkIfExists(corpusPath);
  }
  const parsed = parseDiscoveryResponseResult(raw);
  if (parsed.parseFailed) {
    throw new CurateJsonParseError('discovery');
  }
  const proposals = validateDiscoveryProposals(parsed.proposals, eligibleNotes, currentIndex.principles);

  await kb.withMutationLock(async (mutation) => {
    const refreshedState = readCurateState(curateDb(kb));
    const refreshedIndex = kb.readIndexOrEmpty();
    const refreshedBatch = prepareDiscoveryBatch(curateDb(kb),refreshedIndex, refreshedState, processedThrough);
    if (
      refreshedBatch === null ||
      compareCursor(refreshedBatch.processedThrough, preparedBatch.processedThrough) !== 0 ||
      !sameDiscoverySelection(refreshedBatch.batch.selected, batch.selected)
    ) {
      schedule?.();
      return;
    }

    let state = refreshedBatch.state;
    let index = refreshedIndex;
    const repairFrontier = getCurateRepairFrontier(curateDb(kb));
    const effectiveProcessedThrough = refreshedBatch.processedThrough;

    for (const proposal of proposals) {
      const entry: PendingDiscovery = {
        principle: proposal.slug,
        statement: proposal.statement,
        notes: [...proposal.notes],
        createdAt: nowIsoString(kb.time),
      };

      state = addPendingDiscoveryLocked(kb, state, entry);
      const isRefineProposal = index.principles[proposal.slug] !== undefined && (proposal.absorbs?.length ?? 0) === 0;
      const principleDocument = ensurePrincipleDocumentLocked(kb, mutation, entry, state);
      state = principleDocument.state;
      index = kb.readIndexOrEmpty();

      if (principleDocument.status === 'conflict') {
        if (!isRefineProposal) {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }

        const principlePath = kb.principlePath(assertNoteSlug(entry.principle, 'principle'));
        let rawPrinciple: string;
        try {
          rawPrinciple = kb.storagePort.readFileSync(principlePath, 'utf-8');
        } catch {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }
        const createdAtMatch = rawPrinciple.match(/^createdAt:\s*(.+)$/m);
        if (createdAtMatch === null) {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }

        const updatedAt = nowIsoString(kb.time);
        const nextRaw = [
          '---',
          `createdAt: ${assertNonEmptyText(createdAtMatch[1] ?? '', 'createdAt')}`,
          `updatedAt: ${updatedAt}`,
          '---',
          '',
          entry.statement,
          '',
        ].join('\n');
        writeFileAtomic(kb, principlePath, nextRaw);
        mutation.queueManifestAuthorityDelta(capturePrincipleManifestDelta(entry.principle, nextRaw));
        recordMetadataMutation(kb, CURATE_STALE_REASON);
        const nextIndex = cloneKbIndex(kb.readIndexOrEmpty());
        nextIndex.principles[entry.principle] = entry.statement;
        kb.writeIndex(nextIndex);
        index = nextIndex;
      }

      const targets = filterCandidatesBeforeRepairFrontier(
        buildPrincipleAssignmentTargets(entry.principle, entry.notes, index, effectiveProcessedThrough).map(
          (target) => ({
            cursor: cursorFromTarget(target),
            target,
          }),
        ),
        repairFrontier,
      ).map(({ target }) => target);
      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, mutation, targets, state);
        index = kb.readIndexOrEmpty();
      }

      if (pendingDiscoverySatisfied(kb, entry, effectiveProcessedThrough)) {
        state = removePendingDiscoveryLocked(kb, state, entry);
      }
    }

    for (const proposal of proposals) {
      const absorbs = proposal.absorbs ?? [];
      if (absorbs.length === 0) {
        continue;
      }

      const nextIndex = cloneKbIndex(index);
      for (const absorbSlug of absorbs) {
        const absorbedPending = state.pendingDiscoveries.filter((pending) => pending.principle === absorbSlug);
        for (const pending of absorbedPending) {
          state = removePendingDiscoveryLocked(kb, state, pending);
        }

        unlinkIfExists(kb.principlePath(absorbSlug));
        mutation.queueManifestAuthorityDelta(captureRemovedPrincipleManifestDelta(absorbSlug));
        delete nextIndex.principles[absorbSlug];
      }
      recordMetadataMutation(kb, CURATE_STALE_REASON);
      kb.writeIndex(nextIndex);
      index = nextIndex;

      const targets: MetadataTarget[] = [];
      for (const absorbSlug of absorbs) {
        for (const noteMeta of Object.values(index.entries).filter(isNoteEntry)) {
          const note = noteMeta.slug;
          if (!noteMeta.principles.includes(absorbSlug) || noteMeta.entrySeq === undefined) {
            continue;
          }

          const cursor = noteCursor(note, noteMeta.entrySeq);
          if (
            compareCursor(cursor, effectiveProcessedThrough) > 0 ||
            !isCursorBeforeRepairFrontier(cursor, repairFrontier)
          ) {
            continue;
          }

          targets.push({
            kind: 'note',
            entryId: noteEntryId(assertNoteSlug(note, 'note')),
            slug: assertNoteSlug(note, 'note'),
            entrySeq: noteMeta.entrySeq,
            claimTimeUpdatedAt: noteMeta.updatedAt,
            addPrinciples: [proposal.slug],
            removePrinciples: [absorbSlug],
          });
        }
      }

      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, mutation, targets, state);
        index = kb.readIndexOrEmpty();
      }
    }

    recordDiscoveryAttemptLocked(kb, state, refreshedBatch.batch.nextHighSeq, refreshedBatch.batch.nextOffset);
  });
}
