import { z } from 'zod';

import { participationTypes, resolveReasons, type DiscussCreateInput, type DiscussState } from './session-types.js';

export const controlPhases = ['idle', 'observer_wait', 'evaluate_epoch', 'collect_follow_up', 'synthesize'] as const;
export type ControlPhase = (typeof controlPhases)[number];

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

export type DiscussEventKind = (typeof discussEventKinds)[number];
const discussEventKindSet = new Set<string>(discussEventKinds);

export const discussAgentJobPurposes = ['bid', 'speech', 'epoch_evaluation', 'follow_up', 'synthesis'] as const;
export type DiscussAgentJobPurpose = (typeof discussAgentJobPurposes)[number];

export const discussAgentJobOutcomes = [
  'completed',
  'non_resumable',
  'execution_error',
  'recovery_failed',
  'recovery_missing',
  'retryable_parse_error',
] as const;
export type DiscussAgentJobOutcome = (typeof discussAgentJobOutcomes)[number];

const sourceSeqSchema = z.number().int().positive();

const discussAgentInputSchema = z
  .object({
    name: z.string(),
    persona: z.string(),
    participation: z.enum(participationTypes),
  })
  .strict();

const discussCreateInputSchema = z
  .object({
    topic: z.string(),
    agents: z.array(discussAgentInputSchema),
    min_bid_delay_ms: z.number().int().nonnegative(),
  })
  .strict();

export const sessionCreatedConfigSchema = z
  .object({
    bidThreshold: z.number().finite(),
    maxEpochs: z.number().int().positive(),
    quotaPerEpoch: z.number().int().positive(),
  })
  .strict();

export const sessionCreatedAgentExecutionConfigSchema = z.union([
  z
    .object({
      manual: z.literal(true),
      provider: z.undefined().optional(),
      model: z.undefined().optional(),
    })
    .strict(),
  z
    .object({
      manual: z.literal(false),
      provider: z.string(),
      model: z.string(),
    })
    .strict(),
]);

export const sessionCreatedPayloadSchema = z
  .object({
    input: discussCreateInputSchema,
    config: sessionCreatedConfigSchema,
    agentExecution: z.record(sessionCreatedAgentExecutionConfigSchema),
  })
  .strict();

export const bidSubmittedPayloadSchema = z
  .object({
    agent: z.string(),
    score: z.number().int().min(0).max(100),
    thought: z.string(),
  })
  .strict();

export const participantsExpelledPayloadSchema = z
  .object({
    agents: z.array(z.string()),
    isRespawn: z.boolean(),
  })
  .strict();

export const bidRoundClosedStateMutationsSchema = z
  .object({
    cold_start: z.boolean().optional(),
    fallback_used: z.record(z.boolean()).optional(),
    quota_remaining: z.record(z.number()).optional(),
    epoch: z.number().int().positive().optional(),
  })
  .strict();

export const bidRoundClosedOutcomeSchema = z.union([
  z
    .object({
      winner: z.string(),
      speaker_type: z.enum(['quota', 'fallback', 'cold_start']),
    })
    .strict(),
  z
    .object({
      no_winner: z.literal(true),
      reason: z.enum(resolveReasons),
    })
    .strict(),
]);

export const bidRoundClosedPayloadSchema = z
  .object({
    allBids: z.record(z.number()),
    effectiveBids: z.record(z.number()),
    thoughts: z.record(z.string()),
    outcome: bidRoundClosedOutcomeSchema,
    stateMutations: bidRoundClosedStateMutationsSchema,
  })
  .strict();

export const speechRecordedPayloadSchema = z
  .object({
    agent: z.string(),
    content: z.string(),
    decrementQuota: z.boolean(),
    recordLastSpeechStep: z.number().int().nonnegative().optional(),
  })
  .strict();

export const speechTimedOutPayloadSchema = z
  .object({
    agent: z.string(),
    content: z.string(),
    decrementQuota: z.boolean(),
  })
  .strict();

export const epochSummaryRecordedPayloadSchema = z
  .object({
    summary: z.string(),
  })
  .strict();

export const mustAnswerCarryForwardSetPayloadSchema = z
  .object({
    items: z.array(z.string()),
  })
  .strict();

export const followUpQueueItemSchema = z
  .object({
    agent: z.string(),
    question: z.string(),
  })
  .strict();

export const followUpQueueSetPayloadSchema = z
  .object({
    queue: z.array(followUpQueueItemSchema),
  })
  .strict();

export const followUpAnsweredPayloadSchema = z
  .object({
    agent: z.string(),
    question: z.string(),
    answer: z.string(),
  })
  .strict();

export const sessionEndedPayloadSchema = z
  .object({
    endReason: z.string().optional(),
    endReasonContent: z.string().nullable().optional(),
    force: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const sessionSynthesizedPayloadSchema = z
  .object({
    synthesis: z.string(),
  })
  .strict();

export const agentRunBoundPayloadSchema = z
  .object({
    agent: z.string(),
    executionSessionId: z.string(),
  })
  .strict();

export const agentJobStartedPayloadSchema = z
  .object({
    agent: z.string(),
    jobId: z.string(),
    purpose: z.enum(discussAgentJobPurposes),
    attempt: z.number().int().positive(),
  })
  .strict();

export const agentJobFinishedPayloadSchema = z
  .object({
    agent: z.string(),
    jobId: z.string(),
    outcome: z.enum(discussAgentJobOutcomes),
    attempt: z.number().int().positive(),
  })
  .strict();

function withSourceSeq<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T & { sourceSeq: typeof sourceSeqSchema }, 'strict'> {
  return z
    .object({
      ...shape,
      sourceSeq: sourceSeqSchema,
    })
    .strict();
}

export const discussSessionCreatedBodySchema = sessionCreatedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussBiddingOpenedBodySchema = withSourceSeq({});
export const discussBidSubmittedBodySchema = bidSubmittedPayloadSchema.extend({ sourceSeq: sourceSeqSchema }).strict();
export const discussParticipantsExpelledBodySchema = participantsExpelledPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussBidRoundClosedBodySchema = bidRoundClosedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussSpeechRecordedBodySchema = speechRecordedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussSpeechTimedOutBodySchema = speechTimedOutPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussEpochSummaryRecordedBodySchema = epochSummaryRecordedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussMustAnswerCarryForwardSetBodySchema = mustAnswerCarryForwardSetPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussFollowUpQueueSetBodySchema = followUpQueueSetPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussFollowUpAnsweredBodySchema = followUpAnsweredPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussSessionEndedBodySchema = sessionEndedPayloadSchema.extend({ sourceSeq: sourceSeqSchema }).strict();
export const discussSessionSynthesizedBodySchema = sessionSynthesizedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussAgentRunBoundBodySchema = agentRunBoundPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussAgentJobStartedBodySchema = agentJobStartedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();
export const discussAgentJobFinishedBodySchema = agentJobFinishedPayloadSchema
  .extend({ sourceSeq: sourceSeqSchema })
  .strict();

export const discussEventBodySchemas = {
  'session.created': discussSessionCreatedBodySchema,
  'bidding.opened': discussBiddingOpenedBodySchema,
  'bid.submitted': discussBidSubmittedBodySchema,
  'participants.expelled': discussParticipantsExpelledBodySchema,
  'bid.round.closed': discussBidRoundClosedBodySchema,
  'speech.recorded': discussSpeechRecordedBodySchema,
  'speech.timed_out': discussSpeechTimedOutBodySchema,
  'epoch.summary.recorded': discussEpochSummaryRecordedBodySchema,
  'must_answer.carry_forward.set': discussMustAnswerCarryForwardSetBodySchema,
  'follow_up.queue.set': discussFollowUpQueueSetBodySchema,
  'follow_up.answered': discussFollowUpAnsweredBodySchema,
  'session.ended': discussSessionEndedBodySchema,
  'session.synthesized': discussSessionSynthesizedBodySchema,
  'agent.run.bound': discussAgentRunBoundBodySchema,
  'agent.job.started': discussAgentJobStartedBodySchema,
  'agent.job.finished': discussAgentJobFinishedBodySchema,
} satisfies Record<DiscussEventKind, z.ZodTypeAny>;

export type DiscussJournalBodyByKind = {
  'session.created': z.infer<typeof discussSessionCreatedBodySchema>;
  'bidding.opened': z.infer<typeof discussBiddingOpenedBodySchema>;
  'bid.submitted': z.infer<typeof discussBidSubmittedBodySchema>;
  'participants.expelled': z.infer<typeof discussParticipantsExpelledBodySchema>;
  'bid.round.closed': z.infer<typeof discussBidRoundClosedBodySchema>;
  'speech.recorded': z.infer<typeof discussSpeechRecordedBodySchema>;
  'speech.timed_out': z.infer<typeof discussSpeechTimedOutBodySchema>;
  'epoch.summary.recorded': z.infer<typeof discussEpochSummaryRecordedBodySchema>;
  'must_answer.carry_forward.set': z.infer<typeof discussMustAnswerCarryForwardSetBodySchema>;
  'follow_up.queue.set': z.infer<typeof discussFollowUpQueueSetBodySchema>;
  'follow_up.answered': z.infer<typeof discussFollowUpAnsweredBodySchema>;
  'session.ended': z.infer<typeof discussSessionEndedBodySchema>;
  'session.synthesized': z.infer<typeof discussSessionSynthesizedBodySchema>;
  'agent.run.bound': z.infer<typeof discussAgentRunBoundBodySchema>;
  'agent.job.started': z.infer<typeof discussAgentJobStartedBodySchema>;
  'agent.job.finished': z.infer<typeof discussAgentJobFinishedBodySchema>;
};

export type DiscussJournalBody<K extends DiscussEventKind = DiscussEventKind> = DiscussJournalBodyByKind[K];

export interface DiscussEventEnvelope<K extends DiscussEventKind, P = DiscussPayloadByKind[K]> {
  v: 1;
  sessionId: string;
  projectRoot: string;
  topic: string;
  seq: number;
  kind: K;
  ts: string;
  payload: P;
}

export type SessionCreatedConfig = z.infer<typeof sessionCreatedConfigSchema>;

export type SessionCreatedAgentExecutionConfig = z.infer<typeof sessionCreatedAgentExecutionConfigSchema>;

export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema> & {
  input: DiscussCreateInput;
  config: SessionCreatedConfig;
  agentExecution: Record<string, SessionCreatedAgentExecutionConfig>;
};

export type BiddingOpenedPayload = Record<string, never>;
export type BidSubmittedPayload = z.infer<typeof bidSubmittedPayloadSchema>;

export type ParticipantsExpelledPayload = z.infer<typeof participantsExpelledPayloadSchema>;

export type BidRoundClosedStateMutations = z.infer<typeof bidRoundClosedStateMutationsSchema>;

export type BidRoundClosedOutcome = z.infer<typeof bidRoundClosedOutcomeSchema>;

export type BidRoundClosedPayload = z.infer<typeof bidRoundClosedPayloadSchema> & {
  outcome: BidRoundClosedOutcome;
  stateMutations: BidRoundClosedStateMutations;
};

export type SpeechRecordedPayload = z.infer<typeof speechRecordedPayloadSchema>;

export type SpeechTimedOutPayload = z.infer<typeof speechTimedOutPayloadSchema>;

export type EpochSummaryRecordedPayload = z.infer<typeof epochSummaryRecordedPayloadSchema>;

export type MustAnswerCarryForwardSetPayload = z.infer<typeof mustAnswerCarryForwardSetPayloadSchema>;

export type FollowUpQueueItem = z.infer<typeof followUpQueueItemSchema>;

export type FollowUpQueueSetPayload = z.infer<typeof followUpQueueSetPayloadSchema>;

export type FollowUpAnsweredPayload = z.infer<typeof followUpAnsweredPayloadSchema>;

export type SessionEndedPayload = z.infer<typeof sessionEndedPayloadSchema>;

export type SessionSynthesizedPayload = z.infer<typeof sessionSynthesizedPayloadSchema>;

export type AgentRunBoundPayload = z.infer<typeof agentRunBoundPayloadSchema>;

export type AgentJobStartedPayload = z.infer<typeof agentJobStartedPayloadSchema>;

export type AgentJobFinishedPayload = z.infer<typeof agentJobFinishedPayloadSchema>;

export interface DiscussPayloadByKind {
  'session.created': SessionCreatedPayload;
  'bidding.opened': BiddingOpenedPayload;
  'bid.submitted': BidSubmittedPayload;
  'participants.expelled': ParticipantsExpelledPayload;
  'bid.round.closed': BidRoundClosedPayload;
  'speech.recorded': SpeechRecordedPayload;
  'speech.timed_out': SpeechTimedOutPayload;
  'epoch.summary.recorded': EpochSummaryRecordedPayload;
  'must_answer.carry_forward.set': MustAnswerCarryForwardSetPayload;
  'follow_up.queue.set': FollowUpQueueSetPayload;
  'follow_up.answered': FollowUpAnsweredPayload;
  'session.ended': SessionEndedPayload;
  'session.synthesized': SessionSynthesizedPayload;
  'agent.run.bound': AgentRunBoundPayload;
  'agent.job.started': AgentJobStartedPayload;
  'agent.job.finished': AgentJobFinishedPayload;
}

export type SessionCreatedEvent = DiscussEventEnvelope<'session.created', SessionCreatedPayload>;
export type BiddingOpenedEvent = DiscussEventEnvelope<'bidding.opened', Record<string, never>>;
export type BidSubmittedEvent = DiscussEventEnvelope<'bid.submitted', BidSubmittedPayload>;
export type ParticipantsExpelledEvent = DiscussEventEnvelope<'participants.expelled', ParticipantsExpelledPayload>;
export type BidRoundClosedEvent = DiscussEventEnvelope<'bid.round.closed', BidRoundClosedPayload>;
export type SpeechRecordedEvent = DiscussEventEnvelope<'speech.recorded', SpeechRecordedPayload>;
export type SpeechTimedOutEvent = DiscussEventEnvelope<'speech.timed_out', SpeechTimedOutPayload>;
export type EpochSummaryRecordedEvent = DiscussEventEnvelope<'epoch.summary.recorded', EpochSummaryRecordedPayload>;
export type MustAnswerCarryForwardSetEvent = DiscussEventEnvelope<
  'must_answer.carry_forward.set',
  MustAnswerCarryForwardSetPayload
>;
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
  currentJobPurpose?: DiscussAgentJobPurpose;
  currentAttempt?: number;
  lastAttemptOutcome?: DiscussAgentJobOutcome;
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
  state: DiscussState;
  runtime: PersistedDiscussRuntime;
}

/**
 * Pure live-boundary predicate over a persisted snapshot. Lives next to
 * `PersistedDiscussSnapshot` because it is a derivation of that type with
 * no shell dependency — the previous `discuss/recovery-contract.ts` split
 * was over-decomposition.
 */
export function isWithinLiveSessionBoundary(snapshot: PersistedDiscussSnapshot): boolean {
  return snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'idle';
}

export function isDiscussEventKind(value: string): value is DiscussEventKind {
  return discussEventKindSet.has(value);
}

export function discussEventType(kind: DiscussEventKind): string {
  return `discuss.${kind}`;
}

export function discussKindFromEventType(type: string): DiscussEventKind | null {
  if (!type.startsWith('discuss.')) {
    return null;
  }
  const kind = type.slice('discuss.'.length);
  return isDiscussEventKind(kind) ? kind : null;
}

export function makeEvent<K extends DiscussEventKind>(
  sessionId: string,
  projectRoot: string,
  topic: string,
  seq: number,
  kind: K,
  ts: string,
  payload: DiscussPayloadByKind[K],
): DiscussEventEnvelope<K> {
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
