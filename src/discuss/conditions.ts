import type { DiscussState } from './types.js';

export const allBidsIn = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.pending_bidders.length === 0;

export const speechDelivered = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.last_speech_step === state.step - 1;

export const bidReleased = (agent: string, bidStep: number) =>
  (state: DiscussState): boolean =>
    state.bid_release_step >= bidStep ||
    state.status === 'ended' ||
    state.agents[agent]?.banned === true;

export const isWinner = (agent: string) =>
  (state: DiscussState): boolean =>
    state.status === 'speaking' && state.current_speaker === agent;

export const setupComplete = (state: DiscussState): boolean => state.status !== 'setup';

export const noParticipants = (state: DiscussState): boolean =>
  Object.values(state.agents).every(({ banned, quota_remaining, fallback_used }) => (
    banned || (quota_remaining === 0 && fallback_used)
  ));
