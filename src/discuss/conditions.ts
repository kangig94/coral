/**
 * Discuss session condition predicates - pure functions, zero I/O.
 */

import type { DiscussState } from './types.js';

/** All bids submitted AND in bidding phase. */
export const allBidsIn = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.pending_bidders.length === 0;

/** Speech was delivered and step advanced. */
export const speechDelivered = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.last_speech_step === state.step - 1;

/** Agent's bid has been released (speech/timeout/epoch summary/ban/session end). */
export const bidReleased = (agent: string, bidStep: number) =>
  (state: DiscussState): boolean =>
    state.bid_release_step >= bidStep ||
    state.status === 'ended' ||
    state.agents[agent]?.banned === true;

/** Agent won the floor in current step. */
export const isWinner = (agent: string) =>
  (state: DiscussState): boolean =>
    state.status === 'speaking' && state.current_speaker === agent;

/** Setup finished. */
export const setupComplete = (state: DiscussState): boolean => state.status !== 'setup';

/** No active participants remain (all banned or fully exhausted). */
export const noParticipants = (state: DiscussState): boolean =>
  Object.values(state.agents).every(({ banned, quota_remaining, fallback_used }) => (
    banned || (quota_remaining === 0 && fallback_used)
  ));
