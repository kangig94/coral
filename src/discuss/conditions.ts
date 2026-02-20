/**
 * Discuss session condition predicates — pure functions, zero I/O.
 * Used by discuss_wait to detect when to unblock and by auto-resolve to re-check inside lock.
 */

import type { DiscussState } from './types.js';

/**
 * All bids submitted AND in a phase that expects bids.
 *
 * Phase guard rationale: without `status` check, this was trivially true in `speaking`
 * status because pending_bidders from the previous round remains empty until resetBids.
 */
export const allBidsIn = (s: DiscussState): boolean =>
  (s.status === 'bidding' || s.status === 'voting') &&
  s.pending_bidders.length === 0;

/**
 * Speech was delivered: step advanced past speaking into bidding (monotonic marker).
 *
 * applySpeech sets last_speech_step = step, then increments step, then sets status = 'bidding'.
 * So after speech: last_speech_step = N, step = N+1, status = 'bidding'.
 * Predicate: status is 'bidding' AND last_speech_step === step - 1.
 *
 * Step-relative rationale: `last_speech_step === step` would be immediately false
 * because step was already incremented. The `- 1` accounts for this.
 */
export const speechDelivered = (s: DiscussState): boolean =>
  s.status === 'bidding' && s.last_speech_step === s.step - 1;

/**
 * Agent has something to do right now.
 *
 * current_bids[agent] === null means bid not yet submitted (resetBids sets all to null).
 */
export const actionNeeded = (agent: string) => (s: DiscussState): boolean =>
  (s.status === 'bidding' && s.current_bids[agent] === null) ||
  (s.status === 'speaking' && s.current_speaker === agent) ||
  (s.status === 'voting' && s.current_bids[agent] === null);
