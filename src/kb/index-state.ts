import type { KbIndexState } from './contract.js';

type SequencedIndexState = Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>;

export function currentEntrySeq(state: SequencedIndexState): number {
  return Math.max(state.contentSeq, state.metadataSeq);
}

export function advanceIndexStateToEntrySeq(state: KbIndexState, entrySeq: number): KbIndexState {
  if (entrySeq <= currentEntrySeq(state)) {
    return state;
  }

  return {
    ...state,
    contentSeq: entrySeq,
    metadataSeq: entrySeq,
  };
}
