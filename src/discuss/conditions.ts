/**
 * Discuss session condition predicates - pure functions, zero I/O.
 * Used by discuss(op: "wait") to detect when to unblock and by auto-resolve to re-check inside lock.
 */

import type { DiscussState } from './types.js';

/**
 * All bids submitted AND in bidding phase.
 *
 * Phase guard rationale: without `status` check, this was trivially true in `speaking`
 * status because pending_bidders from the previous round remains empty until resetBids.
 */
export const allBidsIn = (s: DiscussState): boolean =>
  s.status === 'bidding' && s.pending_bidders.length === 0;

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
 * Agent has something to do right now - or session ended (wake up to exit loop).
 *
 * current_bids[agent] === null means bid not yet submitted (resetBids sets all to null).
 * `ended` fires the predicate so agents blocked on discuss(op: "wait", condition: "action_needed")
 * unblock immediately instead of burning 180s timeout.
 */
export const actionNeeded = (agent: string) => (s: DiscussState): boolean =>
  s.status === 'ended' ||
  (s.status === 'bidding' && s.current_bids[agent] === null) ||
  (s.status === 'speaking' && s.current_speaker === agent);
