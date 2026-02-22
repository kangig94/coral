/**
 * Discuss state machine - pure functions, zero I/O.
 * Every state-modifying function: (state, ...args, now: string) -> Result<T>.
 */

import type {
  AgentState,
  DiscussCreateInput,
  DiscussState,
  ResolveReason,
  ResolveResult,
  Result,
  TranscriptEntry,
} from './types.js';

export const DEFAULT_BID_THRESHOLD = 50;
export const DEFAULT_MAX_EPOCHS = 2;
export const DEFAULT_QUOTA_PER_EPOCH = 3;

// ─── ID helpers ─────────────────────────────────────────────────────────────

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

// ─── Display name ───────────────────────────────────────────────────────────

/** Parse display_name from persona first line `# Name - Role`. */
export function parseDisplayName(persona: string, agentName: string): string {
  const firstLine = persona.split('\n')[0] ?? '';
  const stripped = firstLine.replace(/^#\s*/, '');
  const match = stripped.match(/^(.+?)\s+[—–-]\s+/);
  return match?.[1]?.trim() || agentName;
}

// ─── Agent name resolution ─────────────────────────────────────────────────

/**
 * Resolve teammate name -> session agent name.
 * Handles Team suffixes like `architect-1` -> `architect`.
 */
export function resolveAgentName(
  agents: Record<string, AgentState>,
  name: string,
): string | null {
  if (agents[name]) return name;
  const stripped = name.replace(/-\d+$/, '');
  return stripped !== name && agents[stripped] ? stripped : null;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Compare two bid candidates: highest score first, fewest speaks second,
 * alphabetical tiebreak.
 */
function compareBidCandidates(
  agents: Record<string, AgentState>,
  bids: Record<string, number>,
  leftCandidate: [string, number],
  rightCandidate: [string, number],
): number {
  const [leftName] = leftCandidate;
  const [rightName] = rightCandidate;
  const leftScore = bids[leftName];
  const rightScore = bids[rightName];
  if (leftScore !== rightScore) return rightScore - leftScore;
  const leftSpeaks = agents[leftName].total_speaks;
  const rightSpeaks = agents[rightName].total_speaks;
  if (leftSpeaks !== rightSpeaks) return leftSpeaks - rightSpeaks;
  return leftName < rightName ? -1 : 1;
}

/** Build a bids transcript entry. */
function makeBidEntry(
  state: DiscussState,
  allBids: Record<string, number>,
  winner: string | null,
  resolveType: 'normal' | 'fallback' | 'cold_start' | 'no_winner',
  now: string,
): TranscriptEntry {
  return {
    type: 'bids',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    bids: allBids,
    winner,
    resolve_type: resolveType,
  };
}

/** Transition state to speaking with a resolved winner. */
function startSpeaking(
  state: DiscussState,
  allBids: Record<string, number>,
  winner: string,
  speakerType: 'quota' | 'fallback' | 'cold_start',
  now: string,
  extraState?: Partial<DiscussState>,
): Result<[DiscussState, ResolveResult]> {
  const transcriptType = speakerType === 'quota' ? 'normal' : speakerType;
  const newState: DiscussState = {
    ...appendEntry(state, makeBidEntry(state, allBids, winner, transcriptType, now), now),
    current_speaker: winner,
    speaker_type: speakerType,
    status: 'speaking',
    cold_start: false,
    ...extraState,
  };
  return {
    ok: true,
    value: [newState, { winner, speaker_type: speakerType }],
  };
}

/** Return a no-winner resolution with a bids transcript entry. */
function noWinnerResult(
  state: DiscussState,
  allBids: Record<string, number>,
  reason: ResolveReason,
  now: string,
): Result<[DiscussState, ResolveResult]> {
  return {
    ok: true,
    value: [
      appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
      { no_winner: true, reason },
    ],
  };
}

/** Append a transcript entry to state. Sets updated_at and last_activity_at. */
function appendEntry(state: DiscussState, entry: TranscriptEntry, now: string): DiscussState {
  return {
    ...state,
    updated_at: now,
    last_activity_at: now,
    transcript: [...state.transcript, entry],
  };
}

/** Reset current_bids to null and rebuild pending_bidders from eligible agents. */
function resetBids(state: DiscussState): DiscussState {
  const current_bids: Record<string, number | null> = {};
  const pending_bidders: string[] = [];

  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.banned) continue;
    current_bids[name] = null;
    pending_bidders.push(name);
  }

  return {
    ...state,
    current_bids,
    pending_bidders,
    hold_count: 0,
  };
}

/** Pick speaker on cold start: fairness first (fewer speaks), desire second. */
function coldStartPick(state: DiscussState): string | null {
  const eligible = Object.entries(state.agents)
    .filter(([, a]) => !a.banned && a.quota_remaining > 0)
    .sort(([aName, a], [bName, b]) => {
      if (a.total_speaks !== b.total_speaks) return a.total_speaks - b.total_speaks;
      const aScore = state.current_bids[aName] ?? 0;
      const bScore = state.current_bids[bName] ?? 0;
      if (bScore !== aScore) return bScore - aScore;
      return aName < bName ? -1 : 1;
    });
  return eligible[0]?.[0] ?? null;
}

/**
 * Create initial session state (session_id/session_dir/team_name filled by caller).
 */
export function initSession(
  input: DiscussCreateInput,
  now: string,
  bidThreshold = DEFAULT_BID_THRESHOLD,
  maxEpochs = DEFAULT_MAX_EPOCHS,
  quotaPerEpoch = DEFAULT_QUOTA_PER_EPOCH,
): DiscussState {
  const agents: Record<string, AgentState> = {};
  for (const a of input.agents) {
    agents[a.name] = {
      persona: a.persona,
      display_name: parseDisplayName(a.persona, a.name),
      quota_remaining: quotaPerEpoch,
      total_speaks: 0,
      fallback_used: false,
      banned: false,
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
    quota_per_epoch: quotaPerEpoch,
    cold_start: true,
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
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: bidThreshold,
  };
}

/** Transition setup->bidding. Called by discuss_lead({_3_step}) handler. */
export function startBidding(state: DiscussState, now: string): Result<DiscussState> {
  if (state.status !== 'setup') {
    return { ok: false, error: 'not_in_setup', detail: { current: state.status } };
  }

  return {
    ok: true,
    value: {
      ...state,
      status: 'bidding',
      bid_release_step: state.bid_release_step,
      updated_at: now,
      last_activity_at: now,
    },
  };
}

/** Submit a bid. Returns updated state or error. */
export function applyBid(
  state: DiscussState,
  agentName: string,
  score: number,
  now: string,
): Result<DiscussState> {
  const name = resolveAgentName(state.agents, agentName);
  if (!name) {
    return { ok: false, error: 'agent_not_found', detail: { agent_name: agentName } };
  }
  if (state.current_bids[name] !== null) {
    return {
      ok: false,
      error: 'already_bid',
      detail: {
        agent_name: name,
        hint: 'Already bid this round. Wait for bid collection to progress.',
      },
    };
  }

  const pending_bidders = state.pending_bidders.filter((n) => n !== name);
  return {
    ok: true,
    value: {
      ...state,
      current_bids: { ...state.current_bids, [name]: score },
      pending_bidders,
      updated_at: now,
      last_activity_at: now,
    },
  };
}

/**
 * Resolve current bidding round.
 * Cascade: Primary pool -> fallback -> cold start -> no winner/epoch transition.
 */
export function resolveWinner(
  state: DiscussState,
  now: string,
): Result<[DiscussState, ResolveResult]> {
  if (state.status !== 'bidding') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status } };
  }

  const activeAgents = Object.entries(state.agents).filter(([, a]) => !a.banned);
  const missing = activeAgents
    .map(([name]) => name)
    .filter((name) => state.current_bids[name] == null);

  if (missing.length > 0) {
    return { ok: false, error: 'quorum_not_met', detail: { missing } };
  }

  const allBids: Record<string, number> = {};
  for (const [n, v] of Object.entries(state.current_bids)) {
    if (!state.agents[n]?.banned && typeof v === 'number') {
      allBids[n] = v;
    }
  }

  const threshold = state.bid_threshold;
  const cmp = (a: [string, number], b: [string, number]) => compareBidCandidates(state.agents, allBids, a, b);

  const primaryPool = Object.entries(allBids)
    .filter(([n, s]) => s >= threshold && state.agents[n].quota_remaining > 0)
    .sort(cmp);

  if (primaryPool.length > 0) {
    return startSpeaking(state, allBids, primaryPool[0][0], 'quota', now);
  }

  const fallbackPool = Object.entries(allBids)
    .filter(([n, s]) =>
      s >= threshold &&
      state.agents[n].quota_remaining === 0 &&
      !state.agents[n].fallback_used,
    )
    .sort(cmp);

  if (fallbackPool.length > 0) {
    const [winnerName] = fallbackPool[0];
    return startSpeaking(state, allBids, winnerName, 'fallback', now, {
      agents: {
        ...state.agents,
        [winnerName]: { ...state.agents[winnerName], fallback_used: true },
      },
    });
  }

  const allBelowThreshold = Object.values(allBids).every((s) => s < threshold);
  if (allBelowThreshold) {
    if (state.cold_start) {
      const picked = coldStartPick(state);
      if (picked !== null) {
        return startSpeaking(state, allBids, picked, 'cold_start', now);
      }
    }
    return noWinnerResult(state, allBids, 'all_below_threshold', now);
  }

  const allExhausted = activeAgents.every(([, a]) => a.quota_remaining === 0 && a.fallback_used);
  if (!allExhausted) {
    return noWinnerResult(state, allBids, 'all_blocked', now);
  }

  if (state.epoch < state.max_epochs) {
    const agents: Record<string, AgentState> = {};
    for (const [name, a] of Object.entries(state.agents)) {
      if (a.banned) {
        agents[name] = a;
      } else {
        agents[name] = {
          ...a,
          quota_remaining: state.quota_per_epoch,
          fallback_used: false,
        };
      }
    }

    const nextEpochState = resetBids({
      ...appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now), now),
      epoch: state.epoch + 1,
      cold_start: true,
      current_speaker: null,
      speaker_type: null,
      agents,
      step: state.step + 1,
      epoch_summary_written: null,
    });

    return {
      ok: true,
      value: [nextEpochState, { no_winner: true, reason: 'epoch_transition' }],
    };
  }

  return noWinnerResult(state, allBids, 'max_epochs_reached', now);
}

/** Record a speech from the current speaker. */
export function applySpeech(
  state: DiscussState,
  agentName: string,
  content: string,
  now: string,
): Result<DiscussState> {
  if (state.status !== 'speaking') {
    return {
      ok: false,
      error: 'invalid_status',
      detail: { current: state.status, hint: 'Not your turn. Call discuss_lead(_3_step) to move to bidding.' },
    };
  }

  const name = resolveAgentName(state.agents, agentName);
  if (!name) {
    return { ok: false, error: 'agent_not_found', detail: { agent_name: agentName } };
  }

  if (state.current_speaker !== name) {
    return { ok: false, error: 'not_your_turn', detail: { current_speaker: state.current_speaker } };
  }

  const display_name = state.agents[name].display_name;
  const speechEntry: TranscriptEntry = {
    type: 'speech',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    agent: name,
    display_name,
    content,
  };

  const updatedAgent = { ...state.agents[name] };
  if (state.speaker_type === 'quota') {
    updatedAgent.quota_remaining -= 1;
  }
  updatedAgent.total_speaks += 1;

  const newState = resetBids({
    ...appendEntry(state, speechEntry, now),
    agents: { ...state.agents, [name]: updatedAgent },
    current_speaker: null,
    speaker_type: null,
    bid_release_step: state.step,
    step: state.step + 1,
    status: 'bidding',
    last_speech_step: state.step,
  });

  return { ok: true, value: newState };
}

/** Auto timeout handler after speech escalation. */
export function applySpeechTimeout(
  state: DiscussState,
  now: string,
): Result<DiscussState> {
  if (state.status !== 'speaking' || !state.current_speaker) {
    return { ok: false, error: 'not_speaking', detail: { status: state.status } };
  }

  const winner = state.current_speaker;
  const speaker = state.agents[winner];
  const display_name = speaker.display_name;
  const timeoutMsg = `${display_name} (${winner}) timed out without delivering a speech.`;

  const speechEntry: TranscriptEntry = {
    type: 'speech',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    agent: winner,
    display_name,
    content: timeoutMsg,
  };

    const shouldDecrement = state.speaker_type === 'quota';
  const updatedAgent = {
    ...speaker,
    quota_remaining: shouldDecrement ? speaker.quota_remaining - 1 : speaker.quota_remaining,
    total_speaks: speaker.total_speaks + 1,
  };

  return {
    ok: true,
    value: resetBids({
      ...appendEntry(state, speechEntry, now),
      agents: { ...state.agents, [winner]: updatedAgent },
      current_speaker: null,
      speaker_type: null,
      bid_release_step: state.step,
      step: state.step + 1,
      status: 'bidding',
    }),
  };
}

/** Atomically mark a set of non-responsive agents as expelled. */
export function applyExpel(
  state: DiscussState,
  pendingAgents: string[],
  now: string,
): Result<{ state: DiscussState; hint: string }> {
  const isRespawn = state.epoch === 1 && state.step === 1;
  let nextState: DiscussState = { ...state, last_activity_at: now, updated_at: now, hold_count: 0 };

  for (const agent of pendingAgents) {
    if (isRespawn) {
      nextState = {
        ...nextState,
        pending_bidders: nextState.pending_bidders.filter((n) => n !== agent),
        current_bids: { ...nextState.current_bids, [agent]: 0 },
      };
      continue;
    }

    if (!nextState.agents[agent]) continue;
    nextState = {
      ...nextState,
      agents: {
        ...nextState.agents,
        [agent]: {
          ...nextState.agents[agent],
          banned: true,
          quota_remaining: 0,
        },
      },
      pending_bidders: nextState.pending_bidders.filter((n) => n !== agent),
    };
  }

  if (!isRespawn) {
    nextState = resetBids(nextState);
  }
  const hint = isRespawn
    ? `Shutdown and respawn: ${pendingAgents.join(', ')}.`
    : `Banned: ${pendingAgents.join(', ')}. Shutdown and do not respawn.`;

  return { ok: true, value: { state: nextState, hint } };
}

/** Append epoch summary to transcript. */
export function applyEpochSummary(
  state: DiscussState,
  summary: string,
  now: string,
): Result<DiscussState> {
  if (state.status === 'setup') {
    return { ok: false, error: 'session_not_started' };
  }
  if (state.status === 'ended') {
    return { ok: false, error: 'session_ended' };
  }
  if (state.epoch_summary_written === state.epoch) {
    return { ok: false, error: 'epoch_summary_duplicate', detail: { epoch: state.epoch } };
  }

  const entry: TranscriptEntry = { type: 'epoch_summary', epoch: state.epoch, ts: now, summary };
  return {
    ok: true,
    value: {
      ...appendEntry(state, entry, now),
      epoch_summary_written: state.epoch,
      bid_release_step: state.step,
    },
  };
}

/**
 * End the discussion session.
 * `setup` status is intentionally allowed without force.
 */
export function applyEnd(
  state: DiscussState,
  opts: { force?: boolean; reason?: string; synthesis?: string },
  now: string,
): Result<DiscussState> {
  if (state.status === 'ended') {
    if (!opts.synthesis) return { ok: true, value: state };

    const hasSynthesis = state.transcript.some(
      (e) => e.type === 'session_event' && e.event === 'synthesis',
    );
    if (hasSynthesis) return { ok: true, value: state };

    const entry: TranscriptEntry = {
      type: 'session_event',
      epoch: state.epoch,
      ts: now,
      event: 'synthesis',
      detail: opts.synthesis,
    };
    return { ok: true, value: appendEntry(state, entry, now) };
  }

  const { force = false, reason, synthesis } = opts;
  const entries: TranscriptEntry[] = [];

  if (state.status === 'speaking' && !force) {
    return { ok: false, error: 'requires_force', detail: { hint: 'set force=true with reason to end during active speech' } };
  }

  if (state.status === 'speaking') {
    entries.push({
      type: 'session_event',
      epoch: state.epoch,
      ts: now,
      event: 'force_end',
      detail: `Force-ended during speech by ${state.current_speaker}. Reason: ${reason}`,
    });
  }

  if (synthesis) {
    entries.push({
      type: 'session_event',
      epoch: state.epoch,
      ts: now,
      event: 'synthesis',
      detail: synthesis,
    });
  }

  let nextState: DiscussState = {
    ...state,
    status: 'ended',
    current_speaker: null,
    speaker_type: null,
    bid_release_step: state.step,
    updated_at: now,
    last_activity_at: now,
  };

  for (const entry of entries) {
    nextState = appendEntry(nextState, entry, now);
  }

  return { ok: true, value: nextState };
}
