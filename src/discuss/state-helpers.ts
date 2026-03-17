import type { DiscussState, TranscriptEntry } from './types.js';

export function appendEntry(state: DiscussState, entry: TranscriptEntry, now: string): DiscussState {
  return {
    ...state,
    last_activity_at: now,
    transcript: [...state.transcript, entry],
  };
}

export function resetBids(state: DiscussState): DiscussState {
  const currentBids: Record<string, number | null> = {};
  const pendingBidders: string[] = [];

  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.banned) continue;
    currentBids[name] = null;
    if (agent.participation === 'required') {
      pendingBidders.push(name);
    }
  }

  return {
    ...state,
    current_bids: currentBids,
    current_thoughts: {},
    pending_bidders: pendingBidders,
    pending_since_ts: null,
  };
}
