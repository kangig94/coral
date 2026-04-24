import type { KbCorpusLane, KbIndexMutationLane, KbIndexState } from '../contracts.js';
import { currentEntrySeq } from '../index-state.js';

export type KbIndexStateSnapshot = Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>;

export function withoutTextStaleReason(state: KbIndexState): KbIndexState {
  const { textStaleReason: _textStaleReason, ...nextState } = state;
  return nextState;
}

export function captureIndexStateSnapshot(state: KbIndexState | null): KbIndexStateSnapshot {
  return {
    contentSeq: state?.contentSeq ?? 0,
    metadataSeq: state?.metadataSeq ?? 0,
  };
}

export function indexStateMatchesSnapshot(state: KbIndexStateSnapshot, snapshot: KbIndexStateSnapshot): boolean {
  return state.contentSeq === snapshot.contentSeq && state.metadataSeq === snapshot.metadataSeq;
}

export function applyMutationLane(state: KbIndexState, lane: KbIndexMutationLane | null): KbIndexState {
  if (lane === null) {
    return state;
  }

  const nextSeq = currentEntrySeq(state) + 1;
  return {
    ...state,
    contentSeq: lane === 'content' || lane === 'both' ? nextSeq : state.contentSeq,
    metadataSeq: lane === 'metadata' || lane === 'both' ? nextSeq : state.metadataSeq,
  };
}

export function mergeMutationLane(
  current: KbIndexMutationLane | null,
  next: KbIndexMutationLane | null,
): KbIndexMutationLane | null {
  if (next === null || current === 'both') {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'both';
}

export function mergeCorpusLanes(current: readonly KbCorpusLane[], next: readonly KbCorpusLane[]): KbCorpusLane[] {
  const merged = new Set<KbCorpusLane>(current);
  for (const lane of next) {
    merged.add(lane);
  }

  return [...merged].sort();
}

export function mutationLanesFromDiff(before: KbIndexStateSnapshot, after: KbIndexStateSnapshot): KbCorpusLane[] {
  const changedLanes: KbCorpusLane[] = [];
  if (after.contentSeq > before.contentSeq) {
    changedLanes.push('content');
  }
  if (after.metadataSeq > before.metadataSeq) {
    changedLanes.push('metadata');
  }

  return changedLanes;
}
