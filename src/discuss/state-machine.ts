import {
  makeEvent,
  type DiscussDomainEvent,
  type BidRoundClosedStateMutations,
  type SessionCreatedAgentExecutionConfig,
} from './events.js';
import type {
  AgentState,
  DiscussCreateInput,
  DiscussState,
  EndReason,
  Result,
  TranscriptEntry,
  ResolveResult,
} from './session-types.js';

export const DEFAULT_BID_THRESHOLD = 30;
export const DEFAULT_MAX_EPOCHS = 2;
export const DEFAULT_QUOTA_PER_EPOCH = 3;

const END_REASON_CONTENT: Record<Exclude<EndReason, 'already_ended'>, string> = {
  all_below_threshold: 'All participants bid below the threshold. Ending discussion.',
  max_epochs_reached: 'Maximum epochs reached. Ending discussion.',
  all_blocked:
    'Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.',
  no_participants: 'No eligible agents remaining. Ending discussion.',
};

export function endContent(reason: Exclude<EndReason, 'already_ended'>): string {
  return END_REASON_CONTENT[reason];
}

export function resolveAgentName(agents: Record<string, AgentState>, name: string): string | null {
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

function coldStartPick(state: DiscussState): string | null {
  const eligible = Object.entries(state.agents)
    .filter(
      ([name, agent]) => !agent.banned && agent.quota_remaining > 0 && typeof state.current_bids[name] === 'number',
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

export interface SessionCreateOptions {
  bidThreshold?: number;
  maxEpochs?: number;
  quotaPerEpoch?: number;
  agentExecution?: Record<string, SessionCreatedAgentExecutionConfig>;
}

export type DecisionContext = {
  sessionId: string;
  projectRoot: string;
  topic: string;
};

export function decideSessionCreate(
  input: DiscussCreateInput,
  context: DecisionContext,
  seq: number,
  ts: string,
  opts: SessionCreateOptions = {},
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
  const {
    bidThreshold = DEFAULT_BID_THRESHOLD,
    maxEpochs = DEFAULT_MAX_EPOCHS,
    quotaPerEpoch = DEFAULT_QUOTA_PER_EPOCH,
    agentExecution = Object.fromEntries(input.agents.map((agent) => [agent.name, { manual: true }])) as Record<
      string,
      SessionCreatedAgentExecutionConfig
    >,
  } = opts;
  return {
    ok: true,
    value: [
      makeEvent(sessionId, projectRoot, topic, seq, 'session.created', ts, {
        input,
        config: {
          bidThreshold,
          maxEpochs,
          quotaPerEpoch,
        },
        agentExecution,
      }),
      makeEvent(sessionId, projectRoot, topic, seq + 1, 'bidding.opened', ts, {}),
    ],
  };
}

export function decideBid(
  state: DiscussState,
  agentName: string,
  score: number,
  thought: string,
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
  if (state.status !== 'bidding') {
    return {
      ok: false,
      error: 'invalid_phase',
      detail: { status: state.status, hint: 'Bids can only be submitted during the bidding phase.' },
    };
  }
  const name = resolveAgentName(state.agents, agentName);
  if (!name) {
    return { ok: false, error: 'agent_not_found', detail: { agent_name: agentName } };
  }
  if (state.agents[name]?.banned) {
    return { ok: false, error: 'agent_banned', detail: { agent_name: name } };
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
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
  if (state.status !== 'bidding') {
    return { ok: false, error: 'invalid_status', detail: { current: state.status } };
  }

  const requiredAgents = Object.entries(state.agents).filter(
    ([, agent]) => !agent.banned && agent.participation === 'required',
  );
  const missing = requiredAgents
    .map(([name]) => name)
    .filter((name) => state.current_bids[name] === null || state.current_bids[name] === undefined);

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
    bidEntries.filter(([name, score]) => qualifier(name, score)).sort(compare);

  const makeBidRoundClosedEvent = (outcome: ResolveResult, stateMutations: BidRoundClosedStateMutations) =>
    makeEvent(sessionId, projectRoot, topic, seq, 'bid.round.closed', ts, {
      allBids,
      effectiveBids,
      thoughts: { ...state.current_thoughts },
      outcome,
      stateMutations,
    });

  const makeNoWinnerTerminalEvent = (reason: 'all_below_threshold' | 'all_blocked' | 'max_epochs_reached') => [
    makeBidRoundClosedEvent({ no_winner: true as const, reason }, {}),
    makeEvent(sessionId, projectRoot, topic, seq + 1, 'session.ended', ts, {
      endReason: reason,
      endReasonContent: endContent(reason),
    }),
  ];

  const primaryPool = createBidPool((name, score) => score >= threshold && state.agents[name].quota_remaining > 0);
  if (primaryPool.length > 0) {
    const [winner] = primaryPool[0];
    return {
      ok: true,
      value: [makeBidRoundClosedEvent({ winner, speaker_type: 'quota' as const }, { cold_start: false })],
    };
  }

  const fallbackPool = createBidPool(
    (name, score) =>
      score >= threshold && state.agents[name].quota_remaining === 0 && !state.agents[name].fallback_used,
  );
  if (fallbackPool.length > 0) {
    const [winner] = fallbackPool[0];
    return {
      ok: true,
      value: [
        makeBidRoundClosedEvent(
          { winner, speaker_type: 'fallback' as const },
          {
            cold_start: false,
            fallback_used: { [winner]: true },
          },
        ),
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
            makeBidRoundClosedEvent({ winner: picked, speaker_type: 'cold_start' as const }, { cold_start: false }),
          ],
        };
      }
    }

    return {
      ok: true,
      value: makeNoWinnerTerminalEvent('all_below_threshold'),
    };
  }

  const allExhausted = requiredAgents.every(([, agent]) => agent.quota_remaining === 0);
  if (!allExhausted) {
    return {
      ok: true,
      value: makeNoWinnerTerminalEvent('all_blocked'),
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
        makeBidRoundClosedEvent(
          { no_winner: true as const, reason: 'epoch_transition' as const },
          {
            cold_start: true,
            epoch: state.epoch + 1,
            fallback_used: fallbackUsed,
            quota_remaining: quotaRemaining,
          },
        ),
      ],
    };
  }

  return {
    ok: true,
    value: makeNoWinnerTerminalEvent('max_epochs_reached'),
  };
}

export function decideSpeech(
  state: DiscussState,
  agentName: string,
  content: string,
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
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
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
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
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
  if (state.status === 'ended') {
    return { ok: false, error: 'session_ended', detail: { hint: 'Cannot expel agents from an ended session.' } };
  }
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
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
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
    value: [makeEvent(sessionId, projectRoot, topic, seq, 'epoch.summary.recorded', ts, { summary })],
  };
}

export function decideEnd(
  state: DiscussState,
  opts: { force?: boolean; reason?: string; endReason?: Exclude<EndReason, 'already_ended'> },
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
  if (state.status === 'ended') {
    return { ok: true, value: [] };
  }

  const { force = false, reason, endReason } = opts;
  if (state.status === 'speaking' && !force) {
    return {
      ok: false,
      error: 'requires_force',
      detail: { hint: 'set force=true with reason to end during active speech' },
    };
  }

  const endReasonContent =
    endReason !== undefined
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
  context: DecisionContext,
  seq: number,
  ts: string,
): Result<DiscussDomainEvent[]> {
  const { sessionId, projectRoot, topic } = context;
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
    value: [makeEvent(sessionId, projectRoot, topic, seq, 'session.synthesized', ts, { synthesis })],
  };
}
