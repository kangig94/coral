/**
 * Discuss state machine — pure functions, zero I/O.
 * Every state-modifying function: (state, ...args, now: string) → Result<T>.
 * Invariant: zero `node:fs` / `node:path` imports in this file.
 */

import type { AgentState, DiscussState, Result, ResolveResult, TranscriptEntry } from './types.js';
import type { DiscussCreateInput } from './schemas.js';

export const DEFAULT_BID_THRESHOLD = 50;
export const DEFAULT_MAX_EPOCHS = 2;

// ─── ID helpers ───────────────────────────────────────────────────────────────

/** Generate a random 4-char suffix for session ID uniqueness. */
export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/** Format a Date as yymmdd-HHmm (compact timestamp for session IDs). */
export function formatDateId(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(2);
  return `${yy}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Generate topic slug: Unicode letters/digits preserved, hyphens for spaces, ~40 chars. */
export function topicSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return 'untitled';
  if (slug.length <= 40) return slug;
  const cut = slug.lastIndexOf('-', 40);
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, 40);
}

// ─── Display name ─────────────────────────────────────────────────────────────

/**
 * Parse display_name from persona first line `# Name — Role`.
 * Falls back to agentName — never returns empty string.
 */
export function parseDisplayName(persona: string, agentName: string): string {
  const firstLine = persona.split('\n')[0] ?? '';
  const stripped = firstLine.replace(/^#\s*/, '');
  const match = stripped.match(/^(.+?)\s+[—–-]\s+/);
  return match?.[1]?.trim() || agentName;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compare two bid candidates: highest score first, fewest speaks second, alphabetical tiebreak.
 * Used by both primary and fallback pool selection.
 */
function compareBidCandidates(
  agents: Record<string, AgentState>,
  bids: Record<string, number>,
  [aName]: [string, number],
  [bName]: [string, number],
): number {
  const aScore = bids[aName], bScore = bids[bName];
  if (aScore !== bScore) return bScore - aScore;
  const aSpeaks = agents[aName].total_speaks, bSpeaks = agents[bName].total_speaks;
  if (aSpeaks !== bSpeaks) return aSpeaks - bSpeaks;
  return aName < bName ? -1 : 1;
}

/** Build a bids transcript entry. */
function makeBidEntry(
  state: DiscussState,
  allBids: Record<string, number>,
  winner: string | null,
  resolveType: 'normal' | 'fallback' | 'cold_start' | 'no_winner',
  now: string,
): TranscriptEntry {
  return { type: 'bids', step: state.step, epoch: state.epoch, ts: now, bids: allBids, winner, resolve_type: resolveType };
}

/** Append a transcript entry to state. Sets both updated_at and last_activity_at. */
function appendEntry(state: DiscussState, entry: TranscriptEntry, now: string): DiscussState {
  return { ...state, updated_at: now, last_activity_at: now, transcript: [...state.transcript, entry] };
}

/** Reset current_bids to null and rebuild pending_bidders from agent keys (immutable). */
function resetBids(state: DiscussState): DiscussState {
  const current_bids: Record<string, number | null> = {};
  for (const name of Object.keys(state.agents)) current_bids[name] = null;
  return { ...state, current_bids, pending_bidders: Object.keys(state.agents) };
}

/**
 * Pick speaker on cold start: fairness first (fewer speaks), desire second
 * (higher bid), alphabetical tiebreak. Deterministic.
 */
function coldStartPick(state: DiscussState): string | null {
  const eligible = Object.entries(state.agents)
    .filter(([, a]) => a.quota_remaining > 0)
    .sort(([aName, a], [bName, b]) => {
      if (a.total_speaks !== b.total_speaks) return a.total_speaks - b.total_speaks;
      const aScore = state.current_bids[aName] ?? 0;
      const bScore = state.current_bids[bName] ?? 0;
      if (bScore !== aScore) return bScore - aScore;
      return aName < bName ? -1 : 1;
    });
  return eligible[0]?.[0] ?? null;
}

// ─── State machine functions ──────────────────────────────────────────────────

/** Create initial session state (session_id/session_dir/team_name filled by caller). */
export function initSession(
  input: DiscussCreateInput,
  now: string,
  bidThreshold = DEFAULT_BID_THRESHOLD,
  maxEpochs = DEFAULT_MAX_EPOCHS,
): DiscussState {
  const agents: Record<string, AgentState> = {};
  for (const a of input.agents) {
    agents[a.name] = {
      persona: a.persona,
      display_name: parseDisplayName(a.persona, a.name),
      quota_remaining: input.quota_per_epoch,
      total_speaks: 0,
      fallback_used: false,
    };
  }
  const agentNames = input.agents.map((a) => a.name);
  return {
    session_id: '',
    session_dir: '',
    topic: input.topic,
    status: 'setup',
    step: 1,
    epoch: 1,
    max_epochs: maxEpochs,
    quota_per_epoch: input.quota_per_epoch,
    cold_start: true,
    recent_turns: input.recent_turns,
    agents,
    current_bids: Object.fromEntries(agentNames.map((n) => [n, null])),
    pending_bidders: agentNames,
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    team_name: '',
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    last_speech_step: 0,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: bidThreshold,
    transcript_read_step: {},
  };
}

/** Transition session from setup to bidding. Called by discuss({ op: "wait", condition: "all_bids" }) handler. */
export function startBidding(state: DiscussState, now: string): Result<DiscussState> {
  if (state.status !== 'setup') {
    return { ok: false, error: 'not_in_setup', detail: { current: state.status } };
  }
  return { ok: true, value: { ...state, status: 'bidding', updated_at: now, last_activity_at: now } };
}

/** Submit a bid. Returns updated state or error. */
export function applyBid(
  state: DiscussState,
  agentName: string,
  score: number,
  now: string,
): Result<DiscussState> {
  if (state.status !== 'bidding') {
    const hint = state.status === 'setup'
      ? 'Session is in setup phase. Wait for teamlead to call discuss({ op: "wait", condition: "all_bids" }) first.'
      : 'Not in bidding phase. Call discuss(op: "wait") to wait for your turn.';
    return { ok: false, error: 'invalid_status', detail: { current: state.status, hint } };
  }
  if (!state.agents[agentName]) {
    return { ok: false, error: 'agent_not_found', detail: { agent_name: agentName } };
  }
  if (state.current_bids[agentName] !== null) {
    return { ok: false, error: 'already_bid', detail: { agent_name: agentName, hint: 'Already bid this round. Call discuss(op: "wait") for next round.' } };
  }
  // Transcript read enforcement: after the first speech, agents must read transcript before bidding.
  // Exempt: first round of epoch 1 (last_speech_step === 0).
  // Epoch boundary: transcript_read_step is stamped on epoch transition so agents don't need re-read.
  if (state.last_speech_step > 0) {
    const readStep = state.transcript_read_step[agentName] ?? 0;
    if (readStep < state.step) {
      return { ok: false, error: 'read_transcript_first', detail: {
        hint: 'Call discuss(op: "transcript") before bidding. Read recent speeches first.',
      } };
    }
  }
  const pending_bidders = state.pending_bidders.filter((n) => n !== agentName);
  return {
    ok: true,
    value: {
      ...state,
      current_bids: { ...state.current_bids, [agentName]: score },
      pending_bidders,
      updated_at: now,
      last_activity_at: now,
    },
  };
}

/**
 * Resolve current bidding round.
 * Cascade: Primary pool → Fallback pool → Cold start auto-pick → Epoch transition or end.
 * Appends { type: 'bids' } to transcript on every resolution.
 *
 * Sealed-bid: allBids is used for audit (transcript entry) only. Never returned in ResolveResult.
 */
export function resolveWinner(state: DiscussState, now: string): Result<[DiscussState, ResolveResult]> {
  if (state.status !== 'bidding') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status } };
  }

  const missing = Object.keys(state.agents).filter((n) => state.current_bids[n] === null);
  if (missing.length > 0) {
    return { ok: false, error: 'quorum_not_met', detail: { missing } };
  }

  // Build allBids snapshot — used for audit entry and pool filtering only
  const allBids: Record<string, number> = {};
  for (const [n, v] of Object.entries(state.current_bids)) allBids[n] = v as number;

  const threshold = state.bid_threshold;

  // ── Step 1: Primary pool (quota > 0, score >= threshold) ─────────────────
  const cmp = (a: [string, number], b: [string, number]) => compareBidCandidates(state.agents, allBids, a, b);
  const primaryPool = Object.entries(allBids)
    .filter(([n, s]) => s >= threshold && state.agents[n].quota_remaining > 0)
    .sort(cmp);

  if (primaryPool.length > 0) {
    const [winnerName] = primaryPool[0];
    const newState: DiscussState = {
      ...appendEntry(state, makeBidEntry(state, allBids, winnerName, 'normal', now), now),
      current_speaker: winnerName, speaker_type: 'normal', status: 'speaking', cold_start: false,
    };
    return { ok: true, value: [newState, { winner: winnerName, step: state.step, resolve_type: 'normal' }] };
  }

  // ── Step 2: Fallback pool (quota=0, fallback_used=false, score >= threshold) ──
  const fallbackPool = Object.entries(allBids)
    .filter(([n, s]) =>
      s >= threshold &&
      state.agents[n].quota_remaining === 0 &&
      !state.agents[n].fallback_used,
    )
    .sort(cmp);

  if (fallbackPool.length > 0) {
    const [winnerName] = fallbackPool[0];
    const newState: DiscussState = {
      ...appendEntry(state, makeBidEntry(state, allBids, winnerName, 'fallback', now), now),
      agents: { ...state.agents, [winnerName]: { ...state.agents[winnerName], fallback_used: true } },
      current_speaker: winnerName, speaker_type: 'fallback', status: 'speaking', cold_start: false,
    };
    return { ok: true, value: [newState, { winner: winnerName, step: state.step, resolve_type: 'fallback' }] };
  }

  // ── Both pools empty ──────────────────────────────────────────────────────
  const allBelowThreshold = Object.values(allBids).every((s) => s < threshold);

  if (allBelowThreshold) {
    // Step 3: Cold start auto-pick (when cold_start=true)
    if (state.cold_start) {
      const picked = coldStartPick(state);
      if (picked !== null) {
        const newState: DiscussState = {
          ...appendEntry(state, makeBidEntry(state, allBids, picked, 'cold_start', now), now),
          current_speaker: picked, speaker_type: 'cold_start', status: 'speaking', cold_start: false,
        };
        return { ok: true, value: [newState, { winner: picked, step: state.step, resolve_type: 'cold_start' }] };
      }
    }
    // Natural end: all below threshold, cold_start=false (or no eligible agents)
    return {
      ok: true,
      value: [
        appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
        { no_winner: true, step: state.step, reason: 'all_below_threshold' },
      ],
    };
  }

  // ── Step 4: Check if truly all exhausted ─────────────────────────────────
  // (some bids >= threshold but both primary/fallback pools empty)
  const allExhausted = Object.values(state.agents).every(
    (a) => a.quota_remaining === 0 && a.fallback_used,
  );

  if (!allExhausted) {
    // Structurally blocked but NOT all exhausted (agents with quota bid below threshold)
    return {
      ok: true,
      value: [
        appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
        { no_winner: true, step: state.step, reason: 'all_blocked' },
      ],
    };
  }

  // ── Step 5: All exhausted + desire exists → epoch transition ──────────────
  if (state.epoch < state.max_epochs) {
    const agents: Record<string, AgentState> = {};
    for (const [name, a] of Object.entries(state.agents)) {
      agents[name] = { ...a, quota_remaining: state.quota_per_epoch, fallback_used: false };
    }
    // Stamp transcript_read_step for all agents — prevents forced re-read at epoch boundary
    const transcript_read_step: Record<string, number> = {};
    for (const name of Object.keys(state.agents)) {
      transcript_read_step[name] = state.step + 1;
    }
    const newState = resetBids({
      ...appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
      epoch: state.epoch + 1, cold_start: true,
      current_speaker: null, speaker_type: null, agents,
      step: state.step + 1, transcript_read_step,
      epoch_summary_written: null,  // reset for new epoch
    });
    return {
      ok: true,
      value: [newState, {
        no_winner: true, step: state.step, reason: 'epoch_transition',
        new_epoch: true, epoch: state.epoch + 1,
      }],
    };
  }

  // max_epochs reached — no more extensions
  return {
    ok: true,
    value: [
      appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
      { no_winner: true, step: state.step, reason: 'max_epochs_reached' },
    ],
  };
}

/** Record a speech from the current speaker. */
export function applySpeech(
  state: DiscussState,
  agentName: string,
  content: string,
  now: string,
): Result<DiscussState> {
  if (state.status !== 'speaking') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status, hint: 'Not your turn. Call discuss_wait to wait.' } };
  }
  if (state.current_speaker !== agentName) {
    return { ok: false, error: 'not_your_turn', detail: { current_speaker: state.current_speaker } };
  }

  const display_name = state.agents[agentName]?.display_name ?? agentName;
  const speechEntry: TranscriptEntry = {
    type: 'speech', step: state.step, epoch: state.epoch, ts: now,
    agent: agentName, display_name, content,
  };

  const updatedAgent = { ...state.agents[agentName], total_speaks: state.agents[agentName].total_speaks + 1 };
  if (state.speaker_type === 'normal') {
    updatedAgent.quota_remaining -= 1;
  }

  // Set last_speech_step = step (monotonic marker), then increment step
  const newState = resetBids({
    ...appendEntry(state, speechEntry, now),
    agents: { ...state.agents, [agentName]: updatedAgent },
    current_speaker: null, speaker_type: null,
    step: state.step + 1, last_speech_step: state.step, status: 'bidding',
  });
  return { ok: true, value: newState };
}

/** Append epoch summary to transcript. */
export function applyEpochSummary(
  state: DiscussState,
  epoch: number,
  summary: string,
  now: string,
): Result<DiscussState> {
  if (state.status === 'setup') {
    return { ok: false, error: 'session_not_started' };
  }
  if (state.status === 'ended') {
    return { ok: false, error: 'session_ended' };
  }
  if (epoch !== state.epoch) {
    return { ok: false, error: 'epoch_mismatch', detail: { expected: state.epoch } };
  }
  if (state.epoch_summary_written === epoch) {
    return { ok: false, error: 'epoch_summary_duplicate', detail: { epoch } };
  }
  const entry: TranscriptEntry = { type: 'epoch_summary', epoch, ts: now, summary };
  return {
    ok: true,
    value: { ...appendEntry(state, entry, now), epoch_summary_written: epoch },
  };
}

/**
 * End the discussion session.
 * `setup` status is intentionally allowed without force — ending before discussion
 * starts is a valid cancel (e.g., setup failed, agents didn't spawn).
 */
export function applyEnd(
  state: DiscussState,
  opts: { force?: boolean; reason?: string; synthesis?: string },
  now: string,
): Result<DiscussState> {
  if (state.status === 'ended') {
    return { ok: false, error: 'already_ended' };
  }
  const { force = false, reason, synthesis } = opts;
  const entries: TranscriptEntry[] = [];

  if (state.status === 'speaking') {
    if (!force) {
      return { ok: false, error: 'requires_force', detail: { hint: 'set force=true with reason to end during active speech' } };
    }
    entries.push({ type: 'session_event', epoch: state.epoch, ts: now, event: 'force_end',
      detail: `Force-ended during speech by ${state.current_speaker}. Reason: ${reason}` });
  }

  if (synthesis) {
    entries.push({ type: 'session_event', epoch: state.epoch, ts: now, event: 'synthesis', detail: synthesis });
  }

  return {
    ok: true,
    value: {
      ...state,
      status: 'ended',
      current_speaker: null,
      speaker_type: null,
      updated_at: now,
      last_activity_at: now,
      transcript: [...state.transcript, ...entries],
    },
  };
}
