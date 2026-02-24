import type { DiscussState } from './types.js';

export const allBidsIn = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.pending_bidders.length === 0;

export const speechDelivered = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.last_speech_step === state.step - 1;

export const bidReleased = (agentName: string, bidStep: number) =>
  ({ bid_release_step, status, agents }: DiscussState): boolean =>
    bid_release_step >= bidStep || status === 'ended' || agents[agentName]?.banned === true;

export const isWinner = (agentName: string) =>
  ({ status, current_speaker }: DiscussState): boolean =>
    status === 'speaking' && current_speaker === agentName;

export const setupComplete = (state: DiscussState): boolean => state.status !== 'setup';

export const noParticipants = (state: DiscussState): boolean =>
  Object.entries(state.agents)
    .filter(([, a]) => a.participation === 'required')
    .every(([, { banned, quota_remaining, fallback_used }]) =>
      banned || (quota_remaining === 0 && fallback_used),
    );
