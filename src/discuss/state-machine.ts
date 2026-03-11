import {
  makeEvent,
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
  type SessionCreatedAgentExecutionConfig,
} from './events.js';
import {
  makeEmptySnapshot,
  reduceDiscussEvent,
  replayDiscussEvents,
} from './reducer.js';
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
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i];
    if (entry.type === 'speech') return entry.agent;
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

function coldStartPick(state: DiscussState): string | null {
  const eligible = Object.entries(state.agents)
    .filter(([name, agent]) =>
      !agent.banned
      && agent.quota_remaining > 0
      && typeof state.current_bids[name] === 'number',
    )
    .sort(([aName, a], [bName, b]) => {
      if (a.total_speaks !== b.total_speaks) return a.total_speaks - b.total_speaks;
      const aScore = state.current_bids[aName] ?? 0;
      const bScore = state.current_bids[bName] ?? 0;
      if (bScore !== aScore) return bScore - aScore;
      return aName < bName ? -1 : 1;
    });
  return eligible[0]?.[0] ?? null;
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
  const speechEntry: TranscriptEntry = {
    type: 'speech',
    step: state.step,
    epoch: state.epoch,
    ts: now,
    agent: speaker,
    display_name: speakerState.display_name,
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

function makeLegacySnapshot(state: DiscussState): PersistedDiscussSnapshot {
  return {
    schemaVersion: 2,
    sessionId: state.session_id,
    projectRoot: '',
    updatedAt: state.last_activity_at,
    lastAppliedSeq: 0,
    state,
    runtime: {
      controlPhase: 'idle',
      carryForwardMustAnswer: [],
      followUpQueue: [],
      agentRuns: {},
    },
  };
}

function applyLegacyEvent(state: DiscussState, event: DiscussDomainEvent): DiscussState {
  return reduceDiscussEvent(makeLegacySnapshot(state), event).state;
}

export function decideSessionCreate(
  input: DiscussCreateInput,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
  bidThreshold = DEFAULT_BID_THRESHOLD,
  maxEpochs = DEFAULT_MAX_EPOCHS,
  quotaPerEpoch = DEFAULT_QUOTA_PER_EPOCH,
  agentExecution: Record<string, SessionCreatedAgentExecutionConfig> = Object.fromEntries(
    input.agents.map((agent) => [agent.name, { manual: true }]),
  ) as Record<string, SessionCreatedAgentExecutionConfig>,
): Result<DiscussDomainEvent[]> {
  return {
    ok: true,
    value: [
      makeEvent(
        sessionId,
        projectRoot,
        topic,
        seq,
        'session.created',
        ts,
        {
          input,
          config: {
            bidThreshold,
            maxEpochs,
            quotaPerEpoch,
          },
          agentExecution,
        },
      ),
      makeEvent(sessionId, projectRoot, topic, seq + 1, 'bidding.opened', ts, {}),
    ],
  };
}

export function decideBiddingOpen(
  state: DiscussState,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status !== 'setup') {
    return { ok: false, error: 'not_in_setup', detail: { current: state.status } };
  }

  return {
    ok: true,
    value: [makeEvent(sessionId, projectRoot, topic, seq, 'bidding.opened', ts, {})],
  };
}

export function decideBid(
  state: DiscussState,
  agentName: string,
  score: number,
  thought: string,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
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

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'bid.submitted', ts, {
        agent: name,
        score,
        thought,
      }),
    ],
  };
}

export function decideBidRoundClose(
  state: DiscussState,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status !== 'bidding') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status } };
  }

  const requiredAgents = Object.entries(state.agents).filter(([, agent]) =>
    !agent.banned && agent.participation === 'required',
  );
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
  const compare = (left: [string, number], right: [string, number]) =>
    compareBidCandidates(state.agents, effectiveBids, left, right);
  const bidEntries = Object.entries(allBids);

  const createBidPool = (qualifier: (name: string, score: number) => boolean): Array<[string, number]> =>
    bidEntries
      .filter(([name, score]) => qualifier(name, score))
      .sort(compare);

  const primaryPool = createBidPool(
    (name, score) => score >= threshold && state.agents[name].quota_remaining > 0,
  );
  if (primaryPool.length > 0) {
    const [winner] = primaryPool[0];
    return {
      ok: true,
      value: [
        makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
          allBids,
          effectiveBids,
          thoughts: { ...state.current_thoughts },
          outcome: { winner, speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    };
  }

  const fallbackPool = createBidPool((name, score) =>
    score >= threshold
    && state.agents[name].quota_remaining === 0
    && !state.agents[name].fallback_used,
  );
  if (fallbackPool.length > 0) {
    const [winner] = fallbackPool[0];
    return {
      ok: true,
      value: [
        makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
          allBids,
          effectiveBids,
          thoughts: { ...state.current_thoughts },
          outcome: { winner, speaker_type: 'fallback' as const },
          stateMutations: {
            cold_start: false,
            fallback_used: { [winner]: true },
          },
        }),
      ],
    };
  }

  const allBelowThreshold = Object.values(allBids).every((score) => score < threshold);
  if (allBelowThreshold) {
    if (state.cold_start) {
      const picked = coldStartPick(state);
      if (picked !== null) {
        return {
          ok: true,
          value: [
            makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
              allBids,
              effectiveBids,
              thoughts: { ...state.current_thoughts },
              outcome: { winner: picked, speaker_type: 'cold_start' as const },
              stateMutations: { cold_start: false },
            }),
          ],
        };
      }
    }

    return {
      ok: true,
      value: [
        makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
          allBids,
          effectiveBids,
          thoughts: { ...state.current_thoughts },
          outcome: { no_winner: true as const, reason: 'all_below_threshold' as const },
          stateMutations: {},
        }),
        makeEvent(sessionId, projectRoot, topic, seq + 1, 'session.ended', ts, {
          endReason: 'all_below_threshold',
          endReasonContent: endContent('all_below_threshold'),
        }),
      ],
    };
  }

  const allExhausted = requiredAgents.every(([, agent]) => agent.quota_remaining === 0);
  if (!allExhausted) {
    return {
      ok: true,
      value: [
        makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
          allBids,
          effectiveBids,
          thoughts: { ...state.current_thoughts },
          outcome: { no_winner: true as const, reason: 'all_blocked' as const },
          stateMutations: {},
        }),
        makeEvent(sessionId, projectRoot, topic, seq + 1, 'session.ended', ts, {
          endReason: 'all_blocked',
          endReasonContent: endContent('all_blocked'),
        }),
      ],
    };
  }

  if (state.epoch < state.max_epochs) {
    const quotaRemaining: Record<string, number> = {};
    const fallbackUsed: Record<string, boolean> = {};

    for (const [name, agent] of Object.entries(state.agents)) {
      if (agent.banned) continue;
      quotaRemaining[name] = state.quota_per_epoch;
      fallbackUsed[name] = false;
    }

    return {
      ok: true,
      value: [
        makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
          allBids,
          effectiveBids,
          thoughts: { ...state.current_thoughts },
          outcome: { no_winner: true as const, reason: 'epoch_transition' as const },
          stateMutations: {
            cold_start: true,
            epoch: state.epoch + 1,
            fallback_used: fallbackUsed,
            quota_remaining: quotaRemaining,
          },
        }),
      ],
    };
  }

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
        allBids,
        effectiveBids,
        thoughts: { ...state.current_thoughts },
        outcome: { no_winner: true as const, reason: 'max_epochs_reached' as const },
        stateMutations: {},
      }),
      makeEvent(sessionId, projectRoot, topic, seq + 1, 'session.ended', ts, {
        endReason: 'max_epochs_reached',
        endReasonContent: endContent('max_epochs_reached'),
      }),
    ],
  };
}

export function decideSpeech(
  state: DiscussState,
  agentName: string,
  content: string,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status !== 'speaking') {
    return {
      ok: false,
      error: 'invalid_status',
      detail: { current: state.status, hint: 'Not your turn. Session is not in speaking status.' },
    };
  }

  const name = resolveAgentName(state.agents, agentName);
  if (!name) {
    return { ok: false, error: 'agent_not_found', detail: { agent_name: agentName } };
  }

  if (state.current_speaker !== name) {
    return { ok: false, error: 'not_your_turn', detail: { current_speaker: state.current_speaker } };
  }

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'speech.recorded', ts, {
        agent: name,
        content,
        decrementQuota: state.speaker_type !== 'fallback',
        recordLastSpeechStep: state.step,
      }),
    ],
  };
}

export function decideSpeechTimeout(
  state: DiscussState,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status !== 'speaking' || !state.current_speaker) {
    return { ok: false, error: 'not_speaking', detail: { status: state.status } };
  }

  const winner = state.current_speaker;
  const speaker = state.agents[winner];
  const timeoutMsg = `${speaker.display_name} (${winner}) timed out without delivering a speech.`;

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'speech.timed_out', ts, {
        agent: winner,
        content: timeoutMsg,
        decrementQuota: state.speaker_type !== 'fallback',
      }),
    ],
  };
}

export function decideExpel(
  state: DiscussState,
  pendingAgents: string[],
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const isRespawn = state.epoch === 1 && state.step === 1;
  const hint = isRespawn
    ? `Shutdown and respawn: ${pendingAgents.join(', ')}.`
    : `Banned: ${pendingAgents.join(', ')}. Shutdown and do not respawn.`;

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'participants.expelled', ts, {
        agents: [...pendingAgents],
        isRespawn,
        hint,
      }),
    ],
  };
}

export function decideEpochSummary(
  state: DiscussState,
  summary: string,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status === 'setup') {
    return { ok: false, error: 'session_not_started' };
  }
  if (state.status === 'ended') {
    return { ok: false, error: 'session_ended' };
  }
  if (state.epoch_summary_written !== null) {
    return {
      ok: false,
      error: 'epoch_summary_not_due',
      detail: {
        epoch: state.epoch,
        hint: 'No epoch transition has occurred. Continue the discussion loop.',
      },
    };
  }

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'epoch.summary.recorded', ts, { summary }),
    ],
  };
}

export function decideEnd(
  state: DiscussState,
  opts: { force?: boolean; reason?: string; endReason?: Exclude<EndReason, 'already_ended'> },
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status === 'ended') {
    return { ok: true, value: [] };
  }

  const { force = false, reason, endReason } = opts;
  if (state.status === 'speaking' && !force) {
    return { ok: false, error: 'requires_force', detail: { hint: 'set force=true with reason to end during active speech' } };
  }

  const endReasonContent = endReason !== undefined
    ? endContent(endReason)
    : force
      ? (reason ?? state.end_reason_content)
      : state.end_reason_content;

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'session.ended', ts, {
        endReason,
        endReasonContent,
        force,
        reason,
      }),
    ],
  };
}

export function decideSynthesis(
  state: DiscussState,
  synthesis: string,
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  if (state.status !== 'ended') {
    return { ok: false, error: 'not_ended' };
  }

  const alreadyHasSynthesis = state.transcript.some(
    (entry) => entry.type === 'session_event' && entry.event === 'synthesis',
  );
  if (alreadyHasSynthesis) {
    return { ok: true, value: [] };
  }

  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'session.synthesized', ts, { synthesis }),
    ],
  };
}

export function initSession(
  input: DiscussCreateInput,
  now: string,
  bidThreshold = DEFAULT_BID_THRESHOLD,
  maxEpochs = DEFAULT_MAX_EPOCHS,
  quotaPerEpoch = DEFAULT_QUOTA_PER_EPOCH,
): DiscussState {
  const decided = decideSessionCreate(
    input,
    '',
    '',
    input.topic,
    1,
    now,
    bidThreshold,
    maxEpochs,
    quotaPerEpoch,
  );
  if (!decided.ok) {
    const createError = decided.error;
    throw new Error(createError);
  }

  return reduceDiscussEvent(makeEmptySnapshot('', ''), decided.value[0]).state;
}

export function startBidding(state: DiscussState, now: string): Result<DiscussState> {
  const decided = decideBiddingOpen(
    state,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function applyBid(
  state: DiscussState,
  agentName: string,
  score: number,
  thought: string,
  now: string,
): Result<DiscussState> {
  const decided = decideBid(
    state,
    agentName,
    score,
    thought,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function resolveWinner(
  state: DiscussState,
  now: string,
): Result<[DiscussState, ResolveResult]> {
  const decided = decideBidRoundClose(
    state,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  const closeEvent = decided.value[0];
  const nextState = applyLegacyEvent(state, closeEvent);
  const outcome = closeEvent.kind === 'bid.round.closed'
    ? closeEvent.payload.outcome
    : { no_winner: true, reason: 'all_blocked' as const };

  if ('winner' in outcome) {
    return {
      ok: true,
      value: [nextState, { winner: outcome.winner, speaker_type: outcome.speaker_type }],
    };
  }

  return {
    ok: true,
    value: [nextState, { no_winner: true, reason: outcome.reason }],
  };
}

export function applySpeech(
  state: DiscussState,
  agentName: string,
  content: string,
  now: string,
): Result<DiscussState> {
  const decided = decideSpeech(
    state,
    agentName,
    content,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function applySpeechTimeout(
  state: DiscussState,
  now: string,
): Result<DiscussState> {
  const decided = decideSpeechTimeout(
    state,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function applyExpel(
  state: DiscussState,
  pendingAgents: string[],
  now: string,
): Result<{ state: DiscussState; hint: string }> {
  const decided = decideExpel(
    state,
    pendingAgents,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  const expelledEvent = decided.value[0];
  return {
    ok: true,
    value: {
      state: applyLegacyEvent(state, expelledEvent),
      hint: expelledEvent.kind === 'participants.expelled' ? expelledEvent.payload.hint : '',
    },
  };
}

export function applyEpochSummary(
  state: DiscussState,
  summary: string,
  now: string,
): Result<DiscussState> {
  const decided = decideEpochSummary(
    state,
    summary,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function applyEnd(
  state: DiscussState,
  opts: { force?: boolean; reason?: string; endReason?: Exclude<EndReason, 'already_ended'> },
  now: string,
): Result<DiscussState> {
  const decided = decideEnd(
    state,
    opts,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }
  if (decided.value.length === 0) {
    return { ok: true, value: state };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export function applySynthesis(
  state: DiscussState,
  synthesis: string,
  now: string,
): Result<DiscussState> {
  const decided = decideSynthesis(
    state,
    synthesis,
    state.session_id,
    '',
    state.topic,
    1,
    now,
  );
  if (!decided.ok) {
    return { ok: false, error: decided.error, detail: decided.detail };
  }
  if (decided.value.length === 0) {
    return { ok: true, value: state };
  }

  return { ok: true, value: applyLegacyEvent(state, decided.value[0]) };
}

export { replayDiscussEvents };
