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
export const bidReleased = (agent: string, bidStep: number) => (s: DiscussState): boolean =>
  s.bid_release_step >= bidStep ||
  s.status === 'ended' ||
  s.agents[agent]?.banned === true;

/** Agent won the floor in current step. */
export const isWinner = (agent: string) => (s: DiscussState): boolean =>
  s.status === 'speaking' && s.current_speaker === agent;

/** Setup finished. */
export const setupComplete = (s: DiscussState): boolean => s.status !== 'setup';

/** No active participants remain (all banned or fully exhausted). */
export const noParticipants = (s: DiscussState): boolean =>
  Object.values(s.agents).every((a) => a.banned || (a.quota_remaining === 0 && a.fallback_used));
