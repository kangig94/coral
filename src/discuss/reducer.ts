import type {
  AgentJobFinishedEvent,
  AgentJobStartedEvent,
  AgentRunBoundEvent,
  BidRoundClosedEvent,
  DiscussDomainEvent,
  PersistedDiscussAgentRun,
  PersistedDiscussRuntime,
  PersistedDiscussSnapshot,
  SessionCreatedAgentExecutionConfig,
  SessionCreatedEvent,
  SessionEndedEvent,
  SessionSynthesizedEvent,
  SpeechRecordedEvent,
  SpeechTimedOutEvent,
} from './events.js';
import { resolveSessionEndReasonContent } from './end-reasons.js';
import type { AgentState, DiscussState, TranscriptEntry, TranscriptResolveType } from './session-types.js';
import { appendEntry, resetBids } from './state-transitions.js';

function parseDisplayName(persona: string, agentName: string): string {
  const headerLine = persona.split('\n', 1)[0] ?? '';
  const strippedHeader = headerLine.replace(/^#\s*/, '');
  const match = strippedHeader.match(/^(.+?)\s+[—–-]\s+/);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string should fall through to agentName
  return match?.[1]?.trim() || agentName;
}

function makeEmptyState(sessionId: string): DiscussState {
  return {
    session_id: sessionId,
    topic: '',
    status: 'setup',
    step: 1,
    epoch: 1,
    max_epochs: 1,
    quota_per_epoch: 0,
    cold_start: true,
    agents: {},
    current_bids: {},
    current_thoughts: {},
    pending_bidders: [],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: 0,
    created_at: '',
    last_activity_at: '',
    last_speech_step: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: 0,
    min_bid_delay_ms: 0,
  };
}

function makeEmptyRuntime(): PersistedDiscussRuntime {
  return {
    controlPhase: 'idle',
    carryForwardMustAnswer: [],
    followUpQueue: [],
    agentRuns: {},
  };
}

function deriveBiddingControlPhase(state: DiscussState): PersistedDiscussRuntime['controlPhase'] {
  if (state.status !== 'bidding') {
    return 'idle';
  }

  if (state.pending_bidders.length > 0) {
    return 'idle';
  }

  const hasPendingObserver = Object.entries(state.agents).some(
    ([name, agent]) => !agent.banned && agent.participation === 'observer' && state.current_bids[name] === null,
  );

  return hasPendingObserver ? 'observer_wait' : 'idle';
}

function buildRuntimeAgentRuns(
  agentExecution: Record<string, SessionCreatedAgentExecutionConfig>,
): Record<string, PersistedDiscussAgentRun> {
  const agentRuns: Record<string, PersistedDiscussAgentRun> = {};

  for (const [agent, config] of Object.entries(agentExecution)) {
    if (config.manual) {
      continue;
    }
    agentRuns[agent] = {
      provider: config.provider,
      model: config.model,
    };
  }

  return agentRuns;
}

function buildSessionState(event: SessionCreatedEvent): DiscussState {
  const agents: Record<string, AgentState> = {};
  const currentBids: Record<string, number | null> = {};
  const pendingBidders: string[] = [];

  for (const agent of event.payload.input.agents) {
    agents[agent.name] = {
      persona: agent.persona,
      display_name: parseDisplayName(agent.persona, agent.name),
      participation: agent.participation,
      quota_remaining: event.payload.config.quotaPerEpoch,
      total_speaks: 0,
      fallback_used: false,
      banned: false,
    };
    currentBids[agent.name] = null;
    if (agent.participation === 'required') {
      pendingBidders.push(agent.name);
    }
  }

  return {
    session_id: event.sessionId,
    topic: event.payload.input.topic,
    status: 'setup',
    step: 1,
    epoch: 1,
    max_epochs: event.payload.config.maxEpochs,
    quota_per_epoch: event.payload.config.quotaPerEpoch,
    cold_start: true,
    agents,
    current_bids: currentBids,
    current_thoughts: {},
    pending_bidders: pendingBidders,
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: 0,
    created_at: event.ts,
    last_activity_at: event.ts,
    last_speech_step: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: event.payload.config.bidThreshold,
    min_bid_delay_ms: event.payload.input.min_bid_delay_ms,
  };
}

function applyAgentMutations(
  agents: Record<string, AgentState>,
  event: BidRoundClosedEvent,
): Record<string, AgentState> {
  const { fallback_used: fallbackUsed, quota_remaining: quotaRemaining } = event.payload.stateMutations;
  if (!fallbackUsed && !quotaRemaining) {
    return agents;
  }

  const nextAgents: Record<string, AgentState> = { ...agents };
  const names = new Set<string>();
  for (const name of Object.keys(fallbackUsed ?? {})) {
    names.add(name);
  }
  for (const name of Object.keys(quotaRemaining ?? {})) {
    names.add(name);
  }

  for (const name of names) {
    const agent = agents[name];
    if (!agent) continue;
    nextAgents[name] = {
      ...agent,
      fallback_used: fallbackUsed?.[name] ?? agent.fallback_used,
      quota_remaining: quotaRemaining?.[name] ?? agent.quota_remaining,
    };
  }

  return nextAgents;
}

function buildBidEntry(state: DiscussState, event: BidRoundClosedEvent): TranscriptEntry {
  const { outcome } = event.payload;
  const thoughts = Object.keys(event.payload.thoughts).length > 0 ? { thoughts: { ...event.payload.thoughts } } : {};
  let resolveType: TranscriptResolveType = 'no_winner';
  if ('winner' in outcome) {
    resolveType = outcome.speaker_type === 'quota' ? 'normal' : outcome.speaker_type;
  }

  return {
    type: 'bids',
    step: state.step,
    epoch: state.epoch,
    ts: event.ts,
    bids: { ...event.payload.allBids },
    effective_bids: { ...event.payload.effectiveBids },
    ...thoughts,
    winner: 'winner' in outcome ? outcome.winner : null,
    resolve_type: resolveType,
  };
}

function buildSpeechState(state: DiscussState, event: SpeechRecordedEvent | SpeechTimedOutEvent): DiscussState {
  const agentState = state.agents[event.payload.agent];
  if (!agentState) {
    return state;
  }

  const speechEntry: TranscriptEntry = {
    type: 'speech',
    step: state.step,
    epoch: state.epoch,
    ts: event.ts,
    agent: event.payload.agent,
    display_name: agentState.display_name,
    content: event.payload.content,
  };

  const nextState = resetBids({
    ...appendEntry(state, speechEntry, event.ts),
    agents: {
      ...state.agents,
      [event.payload.agent]: {
        ...agentState,
        quota_remaining: event.payload.decrementQuota ? agentState.quota_remaining - 1 : agentState.quota_remaining,
        total_speaks: agentState.total_speaks + 1,
      },
    },
    current_speaker: null,
    speaker_type: null,
    bid_release_step: state.step,
    step: state.step + 1,
    status: 'bidding',
    ...('recordLastSpeechStep' in event.payload && event.payload.recordLastSpeechStep !== undefined
      ? { last_speech_step: event.payload.recordLastSpeechStep }
      : {}),
  });

  return nextState;
}

function ensureAgentRun(runtime: PersistedDiscussRuntime, agent: string): PersistedDiscussAgentRun {
  return runtime.agentRuns[agent] ?? { provider: '', model: '' };
}

function withAgentRunState(
  snapshot: PersistedDiscussSnapshot,
  agent: string,
  ts: string,
  seq: number,
  mutate: (existing: PersistedDiscussAgentRun) => PersistedDiscussAgentRun,
): PersistedDiscussSnapshot {
  const existing = ensureAgentRun(snapshot.runtime, agent);
  return {
    ...snapshot,
    updatedAt: ts,
    lastAppliedSeq: seq,
    runtime: {
      ...snapshot.runtime,
      agentRuns: {
        ...snapshot.runtime.agentRuns,
        [agent]: mutate(existing),
      },
    },
  };
}

function reduceSessionEnded(snapshot: PersistedDiscussSnapshot, event: SessionEndedEvent): PersistedDiscussSnapshot {
  const state = snapshot.state;
  const runtime: PersistedDiscussRuntime = {
    ...snapshot.runtime,
    controlPhase: 'synthesize',
  };

  if (state.status === 'ended') {
    return {
      ...snapshot,
      updatedAt: event.ts,
      lastAppliedSeq: event.seq,
      runtime,
    };
  }

  const endReasonContent = resolveSessionEndReasonContent({
    currentContent: state.end_reason_content,
    explicitContent: event.payload.endReasonContent,
    force: event.payload.force,
    reason: event.payload.reason,
  });

  let nextState: DiscussState = {
    ...state,
    status: 'ended',
    current_speaker: null,
    speaker_type: null,
    bid_release_step: state.step,
    last_activity_at: event.ts,
    end_reason_content: endReasonContent,
  };

  if (state.status === 'speaking' && event.payload.force) {
    const forceEndEntry: TranscriptEntry = {
      type: 'session_event',
      epoch: state.epoch,
      ts: event.ts,
      event: 'force_end',
      detail: `Force-ended during speech by ${state.current_speaker}. Reason: ${event.payload.reason ?? endReasonContent}`,
    };
    nextState = appendEntry(nextState, forceEndEntry, event.ts);
  }

  return {
    ...snapshot,
    updatedAt: event.ts,
    lastAppliedSeq: event.seq,
    state: nextState,
    runtime,
  };
}

function reduceSessionSynthesized(
  snapshot: PersistedDiscussSnapshot,
  event: SessionSynthesizedEvent,
): PersistedDiscussSnapshot {
  const alreadyHasSynthesis = snapshot.state.transcript.some(
    (entry) => entry.type === 'session_event' && entry.event === 'synthesis',
  );
  const runtime: PersistedDiscussRuntime = {
    ...snapshot.runtime,
    controlPhase: 'idle',
  };

  if (snapshot.state.status !== 'ended' || alreadyHasSynthesis) {
    return {
      ...snapshot,
      updatedAt: event.ts,
      lastAppliedSeq: event.seq,
      runtime,
    };
  }

  const synthesisEntry: TranscriptEntry = {
    type: 'session_event',
    epoch: snapshot.state.epoch,
    ts: event.ts,
    event: 'synthesis',
    detail: event.payload.synthesis,
  };

  return {
    ...snapshot,
    updatedAt: event.ts,
    lastAppliedSeq: event.seq,
    state: appendEntry(snapshot.state, synthesisEntry, event.ts),
    runtime,
  };
}

function reduceAgentRunBound(snapshot: PersistedDiscussSnapshot, event: AgentRunBoundEvent): PersistedDiscussSnapshot {
  return withAgentRunState(snapshot, event.payload.agent, event.ts, event.seq, (existing) => ({
    ...existing,
    executionSessionId: event.payload.executionSessionId,
  }));
}

function reduceAgentJobStarted(
  snapshot: PersistedDiscussSnapshot,
  event: AgentJobStartedEvent,
): PersistedDiscussSnapshot {
  return withAgentRunState(snapshot, event.payload.agent, event.ts, event.seq, (existing) => ({
    ...existing,
    currentJobId: event.payload.jobId,
    currentJobPurpose: event.payload.purpose,
    currentAttempt: event.payload.attempt,
  }));
}

function reduceAgentJobFinished(
  snapshot: PersistedDiscussSnapshot,
  event: AgentJobFinishedEvent,
): PersistedDiscussSnapshot {
  return withAgentRunState(snapshot, event.payload.agent, event.ts, event.seq, (existing) => ({
    ...existing,
    currentJobId: undefined,
    currentJobPurpose: undefined,
    currentAttempt: event.payload.attempt,
    lastAttemptOutcome: event.payload.outcome,
  }));
}

export function makeEmptySnapshot(sessionId: string, projectRoot: string): PersistedDiscussSnapshot {
  return {
    schemaVersion: 2,
    sessionId,
    projectRoot,
    updatedAt: '',
    lastAppliedSeq: 0,
    state: makeEmptyState(sessionId),
    runtime: makeEmptyRuntime(),
  };
}

export function reduceDiscussEvent(
  snapshot: PersistedDiscussSnapshot,
  event: DiscussDomainEvent,
): PersistedDiscussSnapshot {
  switch (event.kind) {
    case 'session.created':
      return {
        schemaVersion: 2,
        sessionId: event.sessionId,
        projectRoot: event.projectRoot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: buildSessionState(event),
        runtime: {
          ...makeEmptyRuntime(),
          agentRuns: buildRuntimeAgentRuns(event.payload.agentExecution),
        },
      };

    case 'bidding.opened': {
      const nextState: DiscussState = {
        ...snapshot.state,
        status: 'bidding',
        last_activity_at: event.ts,
      };
      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: nextState,
        runtime: {
          ...snapshot.runtime,
          controlPhase: deriveBiddingControlPhase(nextState),
        },
      };
    }

    case 'bid.submitted': {
      const nextState: DiscussState = {
        ...snapshot.state,
        current_bids: {
          ...snapshot.state.current_bids,
          [event.payload.agent]: event.payload.score,
        },
        current_thoughts: {
          ...snapshot.state.current_thoughts,
          [event.payload.agent]: event.payload.thought,
        },
        pending_bidders: snapshot.state.pending_bidders.filter((name) => name !== event.payload.agent),
        last_activity_at: event.ts,
      };

      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: nextState,
        runtime: {
          ...snapshot.runtime,
          controlPhase: deriveBiddingControlPhase(nextState),
        },
      };
    }

    case 'participants.expelled': {
      let nextState: DiscussState = {
        ...snapshot.state,
        last_activity_at: event.ts,
      };
      const removedPendingBidders = new Set<string>();

      for (const agent of event.payload.agents) {
        if (event.payload.isRespawn) {
          removedPendingBidders.add(agent);
          nextState = {
            ...nextState,
            current_bids: { ...nextState.current_bids, [agent]: 0 },
            current_thoughts: { ...nextState.current_thoughts, [agent]: '' },
          };
          continue;
        }

        const targetAgent = nextState.agents[agent];
        if (!targetAgent || targetAgent.participation === 'observer') {
          continue;
        }

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

      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: nextState,
        runtime: {
          ...snapshot.runtime,
          controlPhase: deriveBiddingControlPhase(nextState),
        },
      };
    }

    case 'bid.round.closed': {
      const bidEntry = buildBidEntry(snapshot.state, event);
      const agents = applyAgentMutations(snapshot.state.agents, event);
      const appendedState = appendEntry(snapshot.state, bidEntry, event.ts);
      const outcome = event.payload.outcome;

      if ('winner' in outcome) {
        const nextState: DiscussState = {
          ...appendedState,
          agents,
          current_speaker: outcome.winner,
          speaker_type: outcome.speaker_type,
          status: 'speaking',
          cold_start: event.payload.stateMutations.cold_start ?? false,
        };

        return {
          ...snapshot,
          updatedAt: event.ts,
          lastAppliedSeq: event.seq,
          state: nextState,
          runtime: {
            ...snapshot.runtime,
            controlPhase: 'idle',
          },
        };
      }

      if (outcome.reason === 'epoch_transition') {
        const nextState = resetBids({
          ...appendedState,
          agents,
          epoch: event.payload.stateMutations.epoch ?? snapshot.state.epoch + 1,
          cold_start: event.payload.stateMutations.cold_start ?? true,
          current_speaker: null,
          speaker_type: null,
          step: snapshot.state.step + 1,
          epoch_summary_written: null,
        });

        return {
          ...snapshot,
          updatedAt: event.ts,
          lastAppliedSeq: event.seq,
          state: nextState,
          runtime: {
            ...snapshot.runtime,
            controlPhase: 'evaluate_epoch',
          },
        };
      }

      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: {
          ...appendedState,
          agents,
          cold_start: event.payload.stateMutations.cold_start ?? appendedState.cold_start,
        },
        runtime: {
          ...snapshot.runtime,
          controlPhase: 'idle',
        },
      };
    }

    case 'speech.recorded':
    case 'speech.timed_out': {
      const nextState = buildSpeechState(snapshot.state, event);
      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: nextState,
        runtime: {
          ...snapshot.runtime,
          controlPhase: deriveBiddingControlPhase(nextState),
        },
      };
    }

    case 'epoch.summary.recorded': {
      const entry: TranscriptEntry = {
        type: 'epoch_summary',
        epoch: snapshot.state.epoch,
        ts: event.ts,
        summary: event.payload.summary,
      };
      const nextState: DiscussState = {
        ...appendEntry(snapshot.state, entry, event.ts),
        epoch_summary_written: snapshot.state.epoch,
        bid_release_step: snapshot.state.step,
        step: snapshot.state.step + 1,
      };

      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: nextState,
        runtime: {
          ...snapshot.runtime,
          controlPhase: deriveBiddingControlPhase(nextState),
        },
      };
    }

    case 'must_answer.carry_forward.set':
      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        runtime: {
          ...snapshot.runtime,
          carryForwardMustAnswer: [...event.payload.items],
        },
      };

    case 'follow_up.queue.set':
      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        runtime: {
          ...snapshot.runtime,
          controlPhase: 'collect_follow_up',
          followUpQueue: event.payload.queue.map((item) => ({ ...item })),
        },
      };

    case 'follow_up.answered': {
      const followUpEntry: TranscriptEntry = {
        type: 'follow_up',
        epoch: snapshot.state.epoch,
        ts: event.ts,
        agent: event.payload.agent,
        question: event.payload.question,
        answer: event.payload.answer,
      };

      return {
        ...snapshot,
        updatedAt: event.ts,
        lastAppliedSeq: event.seq,
        state: appendEntry(snapshot.state, followUpEntry, event.ts),
        runtime: {
          ...snapshot.runtime,
          controlPhase: 'collect_follow_up',
          followUpQueue: snapshot.runtime.followUpQueue.filter(
            (item) => item.agent !== event.payload.agent || item.question !== event.payload.question,
          ),
        },
      };
    }

    case 'session.ended':
      return reduceSessionEnded(snapshot, event);

    case 'session.synthesized':
      return reduceSessionSynthesized(snapshot, event);

    case 'agent.run.bound':
      return reduceAgentRunBound(snapshot, event);

    case 'agent.job.started':
      return reduceAgentJobStarted(snapshot, event);

    case 'agent.job.finished':
      return reduceAgentJobFinished(snapshot, event);
  }
}

export function replayDiscussEvents(
  events: DiscussDomainEvent[],
  seed?: PersistedDiscussSnapshot,
): PersistedDiscussSnapshot {
  const baseSnapshot = seed ?? makeEmptySnapshot(events[0]?.sessionId ?? '', events[0]?.projectRoot ?? '');

  return events.reduce((snapshot, event) => reduceDiscussEvent(snapshot, event), baseSnapshot);
}
