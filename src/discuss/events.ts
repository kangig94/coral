import type {
  DiscussCreateInput,
  DiscussState,
  ResolveReason,
} from './types.js';

export const controlPhases = ['idle', 'observer_wait', 'evaluate_epoch', 'collect_follow_up', 'synthesize'] as const;
export type ControlPhase = typeof controlPhases[number];

export const discussEventKinds = [
  'session.created',
  'bidding.opened',
  'bid.submitted',
  'participants.expelled',
  'bid.round.closed',
  'speech.recorded',
  'speech.timed_out',
  'epoch.summary.recorded',
  'must_answer.carry_forward.set',
  'follow_up.queue.set',
  'follow_up.answered',
  'session.ended',
  'session.synthesized',
  'agent.run.bound',
  'agent.job.started',
  'agent.job.finished',
] as const;

export type DiscussEventKind = typeof discussEventKinds[number];

export interface DiscussEventEnvelope<K extends DiscussEventKind, P> {
  v: 1;
  sessionId: string;
  projectRoot: string;
  topic: string;
  seq: number;
  kind: K;
  ts: string;
  payload: P;
}

export interface SessionCreatedConfig {
  bidThreshold: number;
  maxEpochs: number;
  quotaPerEpoch: number;
}

export type SessionCreatedAgentExecutionConfig =
  | { manual: true; provider?: undefined; model?: undefined }
  | { manual: false; provider: string; model: string };

export interface SessionCreatedPayload {
  input: DiscussCreateInput;
  config: SessionCreatedConfig;
  agentExecution: Record<string, SessionCreatedAgentExecutionConfig>;
}

export interface BidSubmittedPayload {
  agent: string;
  score: number;
  thought: string;
}

export interface ParticipantsExpelledPayload {
  agents: string[];
  isRespawn: boolean;
  hint: string;
}

export interface BidRoundClosedStateMutations {
  cold_start?: boolean;
  fallback_used?: Record<string, boolean>;
  quota_remaining?: Record<string, number>;
  epoch?: number;
}

export type BidRoundClosedOutcome =
  | { winner: string; speaker_type: 'quota' | 'fallback' | 'cold_start' }
  | { no_winner: true; reason: ResolveReason };

export interface BidRoundClosedPayload {
  allBids: Record<string, number>;
  effectiveBids: Record<string, number>;
  thoughts: Record<string, string>;
  outcome: BidRoundClosedOutcome;
  stateMutations: BidRoundClosedStateMutations;
}

export interface SpeechRecordedPayload {
  agent: string;
  content: string;
  decrementQuota: boolean;
  recordLastSpeechStep?: number;
}

export interface SpeechTimedOutPayload {
  agent: string;
  content: string;
  decrementQuota: boolean;
}

export interface EpochSummaryRecordedPayload {
  summary: string;
}

export interface MustAnswerCarryForwardSetPayload {
  items: string[];
}

export interface FollowUpQueueItem {
  agent: string;
  question: string;
}

export interface FollowUpQueueSetPayload {
  queue: FollowUpQueueItem[];
}

export interface FollowUpAnsweredPayload {
  agent: string;
  question: string;
  answer: string;
}

export interface SessionEndedPayload {
  endReason?: string;
  endReasonContent?: string | null;
  force?: boolean;
  reason?: string;
}

export interface SessionSynthesizedPayload {
  synthesis: string;
}

export interface AgentRunBoundPayload {
  agent: string;
  executionSessionId: string;
}

export interface AgentJobStartedPayload {
  agent: string;
  jobId: string;
  purpose: string;
  attempt: number;
}

export interface AgentJobFinishedPayload {
  agent: string;
  jobId: string;
  outcome: string;
  attempt: number;
}

export type SessionCreatedEvent = DiscussEventEnvelope<'session.created', SessionCreatedPayload>;
export type BiddingOpenedEvent = DiscussEventEnvelope<'bidding.opened', Record<string, never>>;
export type BidSubmittedEvent = DiscussEventEnvelope<'bid.submitted', BidSubmittedPayload>;
export type ParticipantsExpelledEvent = DiscussEventEnvelope<'participants.expelled', ParticipantsExpelledPayload>;
export type BidRoundClosedEvent = DiscussEventEnvelope<'bid.round.closed', BidRoundClosedPayload>;
export type SpeechRecordedEvent = DiscussEventEnvelope<'speech.recorded', SpeechRecordedPayload>;
export type SpeechTimedOutEvent = DiscussEventEnvelope<'speech.timed_out', SpeechTimedOutPayload>;
export type EpochSummaryRecordedEvent = DiscussEventEnvelope<'epoch.summary.recorded', EpochSummaryRecordedPayload>;
export type MustAnswerCarryForwardSetEvent = DiscussEventEnvelope<'must_answer.carry_forward.set', MustAnswerCarryForwardSetPayload>;
export type FollowUpQueueSetEvent = DiscussEventEnvelope<'follow_up.queue.set', FollowUpQueueSetPayload>;
export type FollowUpAnsweredEvent = DiscussEventEnvelope<'follow_up.answered', FollowUpAnsweredPayload>;
export type SessionEndedEvent = DiscussEventEnvelope<'session.ended', SessionEndedPayload>;
export type SessionSynthesizedEvent = DiscussEventEnvelope<'session.synthesized', SessionSynthesizedPayload>;
export type AgentRunBoundEvent = DiscussEventEnvelope<'agent.run.bound', AgentRunBoundPayload>;
export type AgentJobStartedEvent = DiscussEventEnvelope<'agent.job.started', AgentJobStartedPayload>;
export type AgentJobFinishedEvent = DiscussEventEnvelope<'agent.job.finished', AgentJobFinishedPayload>;

export type DiscussDomainEvent =
  | SessionCreatedEvent
  | BiddingOpenedEvent
  | BidSubmittedEvent
  | ParticipantsExpelledEvent
  | BidRoundClosedEvent
  | SpeechRecordedEvent
  | SpeechTimedOutEvent
  | EpochSummaryRecordedEvent
  | MustAnswerCarryForwardSetEvent
  | FollowUpQueueSetEvent
  | FollowUpAnsweredEvent
  | SessionEndedEvent
  | SessionSynthesizedEvent
  | AgentRunBoundEvent
  | AgentJobStartedEvent
  | AgentJobFinishedEvent;

export interface PersistedDiscussAgentRun {
  provider: string;
  model: string;
  executionSessionId?: string;
  currentJobId?: string;
  currentJobPurpose?: string;
  currentAttempt?: number;
  lastAttemptOutcome?: string;
}

export interface PersistedDiscussRuntime {
  controlPhase: ControlPhase;
  carryForwardMustAnswer: string[];
  followUpQueue: FollowUpQueueItem[];
  agentRuns: Record<string, PersistedDiscussAgentRun>;
}

export interface PersistedDiscussSnapshot {
  schemaVersion: 2;
  sessionId: string;
  projectRoot: string;
  updatedAt: string;
  lastAppliedSeq: number;
  logByteOffset?: number;
  state: DiscussState;
  runtime: PersistedDiscussRuntime;
}

export function makeEvent<K extends DiscussEventKind, P>(
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  kind: K,
  ts: string,
  payload: P,
): DiscussEventEnvelope<K, P> {
  return {
    v: 1,
    sessionId,
    projectRoot,
    topic,
    seq,
    kind,
    ts,
    payload,
  };
}
