import type {
  AgentState,
  DiscussCreateInput,
  DiscussState,
  EndReason,
  ResolveReason,
  ResolveResult,
  Result,
  TranscriptEntry,
} from './types.js';
import { parseDisplayName } from './util/string.js';

export const DEFAULT_BID_THRESHOLD = 30;
export const DEFAULT_MAX_EPOCHS = 2;
export const DEFAULT_QUOTA_PER_EPOCH = 3;

const END_REASON_CONTENT: Record<Exclude<EndReason, 'already_ended'>, string> = {
  all_below_threshold: 'All participants bid below the threshold. Ending discussion.',
  max_epochs_reached: 'Maximum epochs reached. Ending discussion.',
  all_blocked: 'Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.',
  no_participants: 'No eligible agents remaining. Ending discussion.',
};

export function endContent(reason: Exclude<EndReason, 'already_ended'>): string {
  return END_REASON_CONTENT[reason];
}

export function resolveAgentName(
  agents: Record<string, AgentState>,
  name: string,
): string | null {
  if (agents[name]) return name;
  const baseName = name.replace(/-\d+$/, '');
  return baseName !== name && agents[baseName] ? baseName : null;
}

function collectSubmittedBids(state: DiscussState): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(state.current_bids)) {
    if (!state.agents[name]?.banned && typeof value === 'number') {
      entries.push([name, value]);
    }
  }
  return Object.fromEntries(entries);
}

export function findLastSpeaker(transcript: TranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.type === 'speech') return e.agent;
  }
  return null;
}

export function computeEffectiveBids(
  allBids: Record<string, number>,
  agents: Record<string, AgentState>,
  lastSpeaker: string | null,
): Record<string, number> {
  const names = Object.keys(allBids);
  const participantCount = names.length;
  if (participantCount <= 1) return { ...allBids };

  const imbalanceWeight = 100 / participantCount;
  const recencyWeight = 50 / participantCount;
  const averageSpeaks = names.reduce((sum, name) => sum + agents[name].total_speaks, 0) / participantCount;

  const effective: Record<string, number> = {};
  for (const name of names) {
    const rawBid = allBids[name];
    const imbalance = imbalanceWeight * (averageSpeaks - agents[name].total_speaks);
    const recencyPenalty = name === lastSpeaker ? recencyWeight : 0;
    effective[name] = rawBid + imbalance - recencyPenalty;
  }
  return effective;
}

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

function makeBidEntry(
  state: DiscussState,
  allBids: Record<string, number>,
  winner: string | null,
  resolveType: 'normal' | 'fallback' | 'cold_start' | 'no_winner',
  now: string,
  effectiveBids?: Record<string, number>,
): TranscriptEntry {
  const thoughtsEntry = Object.keys(state.current_thoughts).length > 0
    ? { thoughts: { ...state.current_thoughts } }
    : {};
  return {
    type: 'bids',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    bids: allBids,
    ...(effectiveBids && { effective_bids: effectiveBids }),
    ...thoughtsEntry,
    winner,
    resolve_type: resolveType,
  };
}

function startSpeaking(
  state: DiscussState,
  allBids: Record<string, number>,
  winner: string,
  speakerType: 'quota' | 'fallback' | 'cold_start',
  now: string,
  extraState?: Partial<DiscussState>,
  effectiveBids?: Record<string, number>,
): Result<[DiscussState, ResolveResult]> {
  const transcriptType = speakerType === 'quota' ? 'normal' : speakerType;
  const newState: DiscussState = {
    ...appendEntry(state, makeBidEntry(state, allBids, winner, transcriptType, now, effectiveBids), now),
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

function noWinnerResult(
  state: DiscussState,
  allBids: Record<string, number>,
  reason: ResolveReason,
  now: string,
  effectiveBids?: Record<string, number>,
): Result<[DiscussState, ResolveResult]> {
  return {
    ok: true,
    value: [
      appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now, effectiveBids), now),
      { no_winner: true, reason },
    ],
  };
}

function appendEntry(state: DiscussState, entry: TranscriptEntry, now: string): DiscussState {
  return {
    ...state,
    last_activity_at: now,
    transcript: [...state.transcript, entry],
  };
}

function resetBids(state: DiscussState): DiscussState {
  const current_bids: Record<string, number | null> = {};
  const pending_bidders: string[] = [];

  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.banned) continue;
    current_bids[name] = null;
    if (agent.participation !== 'required') continue;
    pending_bidders.push(name);
  }

  return {
    ...state,
    current_bids,
    current_thoughts: {},
    pending_bidders,
    hold_count: 0,
  };
}

function coldStartPick(state: DiscussState): string | null {
  const eligible = Object.entries(state.agents)
    .filter(([, a]) => !a.banned && a.quota_remaining > 0 && a.participation === 'required')
    .sort(([aName, a], [bName, b]) => {
      if (a.total_speaks !== b.total_speaks) return a.total_speaks - b.total_speaks;
      const aScore = state.current_bids[aName] ?? 0;
      const bScore = state.current_bids[bName] ?? 0;
      if (bScore !== aScore) return bScore - aScore;
      return aName < bName ? -1 : 1;
    });
  return eligible[0]?.[0] ?? null;
}

export function initSession(
  input: DiscussCreateInput,
  now: string,
  bidThreshold = DEFAULT_BID_THRESHOLD,
  maxEpochs = DEFAULT_MAX_EPOCHS,
  quotaPerEpoch = DEFAULT_QUOTA_PER_EPOCH,
): DiscussState {
  const agents: Record<string, AgentState> = {};
  const agentNames: string[] = [];
  const requiredNames: string[] = [];
  for (const a of input.agents) {
    agents[a.name] = {
      persona: a.persona,
      display_name: parseDisplayName(a.persona, a.name),
      participation: a.participation,
      quota_remaining: quotaPerEpoch,
      total_speaks: 0,
      fallback_used: false,
      banned: false,
    };
    agentNames.push(a.name);
    if (a.participation === 'required') {
      requiredNames.push(a.name);
    }
  }
  return {
    session_id: '',
    topic: input.topic,
    status: 'setup',
    step: 1,
    epoch: 1,
    max_epochs: maxEpochs,
    quota_per_epoch: quotaPerEpoch,
    cold_start: true,
    agents,
    current_bids: Object.fromEntries(agentNames.map((n) => [n, null])),
    current_thoughts: {},
    pending_bidders: requiredNames,
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    created_at: now,
    last_activity_at: now,
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: bidThreshold,
    min_bid_delay_ms: input.min_bid_delay_ms,
  };
}

export function startBidding(state: DiscussState, now: string): Result<DiscussState> {
  if (state.status !== 'setup') {
    return { ok: false, error: 'not_in_setup', detail: { current: state.status } };
  }

  return {
    ok: true,
    value: {
      ...state,
      status: 'bidding',
      last_activity_at: now,
    },
  };
}

export function applyBid(
  state: DiscussState,
  agentName: string,
  score: number,
  thought: string,
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

  const current_thoughts = state.current_thoughts ?? {};
  return {
    ok: true,
    value: {
      ...state,
      current_bids: { ...state.current_bids, [name]: score },
      current_thoughts: { ...current_thoughts, [name]: thought },
      pending_bidders: state.pending_bidders.filter((n) => n !== name),
      last_activity_at: now,
    },
  };
}

export function resolveWinner(
  state: DiscussState,
  now: string,
): Result<[DiscussState, ResolveResult]> {
  if (state.status !== 'bidding') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status } };
  }

  const requiredAgents = Object.entries(state.agents).filter(([, a]) => !a.banned && a.participation === 'required');
  const missing = requiredAgents
    .map(([name]) => name)
    .filter((name) => state.current_bids[name] == null);

  if (missing.length > 0) {
    return { ok: false, error: 'quorum_not_met', detail: { missing } };
  }

  const allBids = collectSubmittedBids(state);

  const lastSpeaker = findLastSpeaker(state.transcript);
  const effectiveBids = computeEffectiveBids(allBids, state.agents, lastSpeaker);
  const threshold = state.bid_threshold;
  const cmp = (a: [string, number], b: [string, number]) => compareBidCandidates(state.agents, effectiveBids, a, b);
  const bidEntries = Object.entries(allBids);

  const createBidPool = (qualifier: (name: string, score: number) => boolean): Array<[string, number]> =>
    bidEntries
      .filter(([name, score]) => qualifier(name, score))
      .sort(cmp);

  const primaryPool = createBidPool((name, score) => score >= threshold && state.agents[name].quota_remaining > 0);
  if (primaryPool.length > 0) {
    return startSpeaking(state, allBids, primaryPool[0][0], 'quota', now, undefined, effectiveBids);
  }

  const fallbackPool = createBidPool((name, score) =>
    score >= threshold
    && state.agents[name].quota_remaining === 0
    && !state.agents[name].fallback_used,
  );

  if (fallbackPool.length > 0) {
    const [winnerName] = fallbackPool[0];
    return startSpeaking(state, allBids, winnerName, 'fallback', now, {
      agents: {
        ...state.agents,
        [winnerName]: { ...state.agents[winnerName], fallback_used: true },
      },
    }, effectiveBids);
  }

  const allBelowThreshold = Object.values(allBids).every((s) => s < threshold);
  if (allBelowThreshold) {
    if (state.cold_start) {
      const picked = coldStartPick(state);
      if (picked !== null) {
        return startSpeaking(state, allBids, picked, 'cold_start', now, undefined, effectiveBids);
      }
    }
    return noWinnerResult(state, allBids, 'all_below_threshold', now, effectiveBids);
  }

  const allExhausted = requiredAgents.every(([, a]) => a.quota_remaining === 0);
  if (!allExhausted) {
    return noWinnerResult(state, allBids, 'all_blocked', now, effectiveBids);
  }

  if (state.epoch < state.max_epochs) {
    const agents = Object.fromEntries(
      Object.entries(state.agents).map(([name, agent]) => [
        name,
        agent.banned
          ? agent
          : { ...agent, quota_remaining: state.quota_per_epoch, fallback_used: false },
      ]),
    ) as Record<string, AgentState>;

    const nextEpochState = resetBids({
      ...appendEntry(state, makeBidEntry(state, allBids, null, 'no_winner', now, effectiveBids), now),
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

  return noWinnerResult(state, allBids, 'max_epochs_reached', now, effectiveBids);
}

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

  const speechState = buildSpeechState({
    state,
    speaker: name,
    content,
    now,
    decrementQuota: state.speaker_type !== 'fallback',
    recordLastSpeechStep: state.step,
  });
  return { ok: true, value: speechState };
}

function buildSpeechState({
  state,
  speaker,
  content,
  now,
  decrementQuota,
  recordLastSpeechStep,
}: {
  state: DiscussState;
  speaker: string;
  content: string;
  now: string;
  decrementQuota: boolean;
  recordLastSpeechStep?: number;
}): DiscussState {
  const speakerState = state.agents[speaker];
  const display_name = speakerState.display_name;
  const speechEntry: TranscriptEntry = {
    type: 'speech',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    agent: speaker,
    display_name,
    content,
  };

  const updatedAgent = {
    ...speakerState,
    quota_remaining: decrementQuota ? speakerState.quota_remaining - 1 : speakerState.quota_remaining,
    total_speaks: speakerState.total_speaks + 1,
  };

  return resetBids({
    ...appendEntry(state, speechEntry, now),
    agents: { ...state.agents, [speaker]: updatedAgent },
    current_speaker: null,
    speaker_type: null,
    bid_release_step: state.step,
    step: state.step + 1,
    status: 'bidding',
    ...(recordLastSpeechStep === undefined ? {} : { last_speech_step: recordLastSpeechStep }),
  });
}

export function applySpeechTimeout(
  state: DiscussState,
  now: string,
): Result<DiscussState> {
  if (state.status !== 'speaking' || !state.current_speaker) {
    return { ok: false, error: 'not_speaking', detail: { status: state.status } };
  }

  const winner = state.current_speaker;
  const speaker = state.agents[winner];
  const displayName = speaker.display_name;
  const timeoutMsg = `${displayName} (${winner}) timed out without delivering a speech.`;
  return {
    ok: true,
    value: buildSpeechState({
      state,
      speaker: winner,
      content: timeoutMsg,
      now,
      decrementQuota: state.speaker_type !== 'fallback',
    }),
  };
}

export function applyExpel(
  state: DiscussState,
  pendingAgents: string[],
  now: string,
): Result<{ state: DiscussState; hint: string }> {
  const isRespawn = state.epoch === 1 && state.step === 1;
  let nextState: DiscussState = { ...state, last_activity_at: now, hold_count: 0 };
  const removedPendingBidders = new Set<string>();

  for (const agent of pendingAgents) {
    if (isRespawn) {
      removedPendingBidders.add(agent);
      nextState = {
        ...nextState,
        current_bids: { ...nextState.current_bids, [agent]: 0 },
        current_thoughts: { ...nextState.current_thoughts, [agent]: '' },
      };
      continue;
    }

    const targetAgent = nextState.agents[agent];
    if (!targetAgent) continue;
    if (targetAgent.participation === 'observer') continue;
    removedPendingBidders.add(agent);

    nextState = {
      ...nextState,
      agents: {
        ...nextState.agents,
        [agent]: {
          ...targetAgent,
          banned: true,
          quota_remaining: 0,
        },
      },
    };
  }
  if (removedPendingBidders.size > 0) {
    nextState = {
      ...nextState,
      pending_bidders: nextState.pending_bidders.filter((name) => !removedPendingBidders.has(name)),
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
      step: state.step + 1,
    },
  };
}

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
    last_activity_at: now,
  };

  for (const entry of entries) {
    nextState = appendEntry(nextState, entry, now);
  }

  return { ok: true, value: nextState };
}
