// Per-event describers for the `discuss/*` stream. Owned by the discuss domain
// and composed into the default `EventDescriberMap` by `read-model/event-describers.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import {
  discussAgentJobFinishedBodySchema,
  discussAgentJobStartedBodySchema,
  discussAgentRunBoundBodySchema,
  discussBiddingOpenedBodySchema,
  discussBidRoundClosedBodySchema,
  discussBidSubmittedBodySchema,
  discussEpochSummaryRecordedBodySchema,
  discussFollowUpAnsweredBodySchema,
  discussFollowUpQueueSetBodySchema,
  discussMustAnswerCarryForwardSetBodySchema,
  discussParticipantsExpelledBodySchema,
  discussSessionCreatedBodySchema,
  discussSessionEndedBodySchema,
  discussSessionSynthesizedBodySchema,
  discussSpeechRecordedBodySchema,
  discussSpeechTimedOutBodySchema,
  type DiscussAgentJobOutcome,
} from './events.js';

function describeOutcome(outcome: DiscussAgentJobOutcome): string {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'non_resumable':
      return 'completed without resumable continuity';
    case 'execution_error':
      return 'failed during execution';
    case 'recovery_failed':
      return 'failed during recovery';
    case 'recovery_missing':
      return 'lost its recovery record';
    case 'retryable_parse_error':
      return 'failed with retryable parse error';
  }
}

const sessionCreated = typedDescriber(
  discussSessionCreatedBodySchema,
  (body) => `Discuss session created: ${body.input.topic}.`,
);
const biddingOpened = typedDescriber(discussBiddingOpenedBodySchema, () => 'Discuss bidding opened.');
const bidSubmitted = typedDescriber(discussBidSubmittedBodySchema, (body) => `Discuss bid submitted by ${body.agent}.`);
const participantsExpelled = typedDescriber(
  discussParticipantsExpelledBodySchema,
  (body) => `Discuss participants expelled: ${body.agents.join(', ')}.`,
);
const bidRoundClosed = typedDescriber(discussBidRoundClosedBodySchema, (body) =>
  'winner' in body.outcome
    ? `Discuss bid round closed with ${body.outcome.winner} selected.`
    : `Discuss bid round closed with no winner: ${body.outcome.reason}.`,
);
const speechRecorded = typedDescriber(
  discussSpeechRecordedBodySchema,
  (body) => `Discuss speech recorded from ${body.agent}.`,
);
const speechTimedOut = typedDescriber(
  discussSpeechTimedOutBodySchema,
  (body) => `Discuss speech timed out for ${body.agent}.`,
);
const epochSummaryRecorded = typedDescriber(
  discussEpochSummaryRecordedBodySchema,
  () => 'Discuss epoch summary recorded.',
);
const mustAnswerCarryForwardSet = typedDescriber(
  discussMustAnswerCarryForwardSetBodySchema,
  (body) => `Discuss must-answer carry-forward set with ${body.items.length} item(s).`,
);
const followUpQueueSet = typedDescriber(
  discussFollowUpQueueSetBodySchema,
  (body) => `Discuss follow-up queue set with ${body.queue.length} item(s).`,
);
const followUpAnswered = typedDescriber(
  discussFollowUpAnsweredBodySchema,
  (body) => `Discuss follow-up answered by ${body.agent}.`,
);
const sessionEnded = typedDescriber(discussSessionEndedBodySchema, (body) => {
  const reason = body.reason ?? body.endReason ?? body.endReasonContent ?? 'completed';
  return `Discuss session ended: ${reason}.`;
});
const sessionSynthesized = typedDescriber(discussSessionSynthesizedBodySchema, () => 'Discuss synthesis recorded.');
const agentRunBound = typedDescriber(
  discussAgentRunBoundBodySchema,
  (body) => `Discuss agent ${body.agent} bound to execution session ${body.executionSessionId}.`,
);
const agentJobStarted = typedDescriber(
  discussAgentJobStartedBodySchema,
  (body) => `Discuss agent ${body.agent} started ${body.purpose} job ${body.jobId} (attempt ${body.attempt}).`,
);
const agentJobFinished = typedDescriber(
  discussAgentJobFinishedBodySchema,
  (body) => `Discuss agent ${body.agent} job ${body.jobId} ${describeOutcome(body.outcome)} (attempt ${body.attempt}).`,
);

export const discussEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['discuss:discuss.session.created', sessionCreated],
  ['discuss:discuss.bidding.opened', biddingOpened],
  ['discuss:discuss.bid.submitted', bidSubmitted],
  ['discuss:discuss.participants.expelled', participantsExpelled],
  ['discuss:discuss.bid.round.closed', bidRoundClosed],
  ['discuss:discuss.speech.recorded', speechRecorded],
  ['discuss:discuss.speech.timed_out', speechTimedOut],
  ['discuss:discuss.epoch.summary.recorded', epochSummaryRecorded],
  ['discuss:discuss.must_answer.carry_forward.set', mustAnswerCarryForwardSet],
  ['discuss:discuss.follow_up.queue.set', followUpQueueSet],
  ['discuss:discuss.follow_up.answered', followUpAnswered],
  ['discuss:discuss.session.ended', sessionEnded],
  ['discuss:discuss.session.synthesized', sessionSynthesized],
  ['discuss:discuss.agent.run.bound', agentRunBound],
  ['discuss:discuss.agent.job.started', agentJobStarted],
  ['discuss:discuss.agent.job.finished', agentJobFinished],
]);
