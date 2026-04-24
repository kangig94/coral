import type { KbIndexMutationLane, KbIndexState } from './contracts.js';
import { applyMutationLane } from './corpus/lanes.js';

type PendingMutationState = {
  pendingMutationLane: KbIndexMutationLane | null;
  pendingMutationReason?: string;
};

function mergeTextStaleReason(
  state: KbIndexState,
  reason: string | undefined,
): Pick<KbIndexState, 'textStaleReason'> | Record<string, never> {
  if (reason !== undefined) {
    return { textStaleReason: reason };
  }
  return state.textStaleReason === undefined ? {} : { textStaleReason: state.textStaleReason };
}

export function previewPendingMutationState(
  state: KbIndexState,
  pending: PendingMutationState,
): KbIndexState {
  return {
    ...applyMutationLane(state, pending.pendingMutationLane),
    ...mergeTextStaleReason(state, pending.pendingMutationReason),
  };
}

export function commitMutationState(
  state: KbIndexState,
  lane: KbIndexMutationLane,
  reason?: string,
): KbIndexState {
  return {
    ...applyMutationLane(state, lane),
    ...(reason === undefined ? {} : { textStaleReason: reason }),
  };
}
