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

export const noEligibleParticipants = (state: DiscussState): boolean =>
  Object.values(state.agents).every((agent) =>
    agent.participation !== 'required'
    || agent.banned
    || (agent.quota_remaining === 0 && agent.fallback_used),
  );
