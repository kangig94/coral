import { z } from 'zod';
import { errorMessage } from '../../shared/mcp-utils.js';

import {
  makeEvent,
  type DiscussDomainEvent,
  type FollowUpQueueItem,
  type PersistedDiscussSnapshot,
} from '../../discuss/events.js';
import { reduceDiscussEvent } from '../../discuss/reducer.js';
import {
  decideBid,
  decideEnd,
  decideEpochSummary,
  decideExpel,
  decideSpeech,
  decideSpeechTimeout,
  decideSynthesis,
  resolveAgentName,
} from '../../discuss/state-machine.js';
import type { DiscussState, TranscriptEntry } from '../../discuss/types.js';
import { renderEntries, renderHeader } from '../../discuss/transcript.js';
import { nowIsoString } from '../../discuss/util/time.js';
import type { CallerContext } from '../request-context.js';
import { buildBidPrompt, buildFirstTurnInstruction, buildSpeechPrompt } from './prompts.js';
import {
  CONTINUE_TURN_INSTRUCTION,
  DEFAULT_DISCUSS_PROVIDER,
  FOLLOW_UP_TURN_INSTRUCTION,
  PURPOSE_BID,
  PURPOSE_EPOCH_EVALUATION,
  PURPOSE_FOLLOW_UP,
  PURPOSE_SPEECH,
  PURPOSE_SYNTHESIS,
  currentAgentRun,
  executeAgentAttempt,
  isManualParticipant,
  isAttemptSuccess,
  normalizeModel,
  recordJobFinished,
  runFacilitatorTurn,
} from './executor.js';
import { DiscussManagerError, type DiscussContext, unwrapResult } from './context.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from './persistence.js';
import { detachSession } from './registry.js';

const BID_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;
const SPEECH_TIMEOUT_MS = 5 * 60 * 1000;
const EPOCH_EVAL_TIMEOUT_MS = 5 * 60 * 1000;
const CONVERGENCE_THRESHOLD = 7;
const MAX_BID_ATTEMPTS = 3;
const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MUST_ANSWER_SEPARATOR = '\u0000';

const BidSchema = z.object({
  score: z.number().int().min(0).max(100),
  thought: z.string(),
});

const EpochEvaluationSchema = z.object({
  convergence: z.number().min(0).max(10),
  summary: z.string(),
  must_answer: z.array(
    z.object({
      to: z.string(),
      question: z.string(),
    }),
  ),
});

type MustAnswerItem = {
  to: string;
  question: string;
};

export type EpochEvaluation = {
  convergence: number;
  summary: string;
  mustAnswer: MustAnswerItem[];
};

type BidOutcome = {
  agentName: string;
  score: number;
  thought: string;
  executionFailure: boolean;
  shouldExpel: boolean;
  answeredCarryForward: boolean;
};

export type SubflowResult = {
  shouldResume: boolean;
};

function stripFencedCodeBlock(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function buildBidRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return ONLY valid JSON in this exact shape: {"score": 0-100, "thought": "..."}',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

function buildFollowUpRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return only the answer text. Do not use markdown or code fences.',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

function parseBidResponse(content: string): { score: number; thought: string } {
  const parsed = JSON.parse(stripFencedCodeBlock(content));
  return BidSchema.parse(parsed);
}

function normalizeFollowUpAnswer(content: string): string {
  return stripFencedCodeBlock(content).trim();
}

function lastSpeech(transcript: TranscriptEntry[]): { speaker: string; content: string } | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.type === 'speech') {
      return { speaker: entry.agent, content: entry.content };
    }
  }
  return null;
}

function renderTranscriptText(state: DiscussState): string {
  return `${renderHeader(state.topic, state.agents)}${renderEntries(state.transcript, state.agents)}`;
}

function applyEventsLocally(
  snapshot: PersistedDiscussSnapshot,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return events.reduce((current, event) => reduceDiscussEvent(current, event), snapshot);
}

function encodeCarryForward(item: MustAnswerItem): string {
  return `${item.to}${MUST_ANSWER_SEPARATOR}${item.question}`;
}

function parseMustAnswerItem(value: string): MustAnswerItem | null {
  const separator = value.indexOf(MUST_ANSWER_SEPARATOR);
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }

  return {
    to: value.slice(0, separator),
    question: value.slice(separator + 1),
  };
}

function resolveMustAnswerTarget(state: DiscussState, rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (target.length === 0) {
    return null;
  }

  const resolved = resolveAgentName(state.agents, target);
  if (resolved !== null) {
    return resolved;
  }

  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.display_name === target) {
      return name;
    }
  }

  return null;
}

function normalizeMustAnswerItems(
  state: DiscussState,
  items: z.infer<typeof EpochEvaluationSchema>['must_answer'],
): MustAnswerItem[] {
  const normalized: MustAnswerItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const target = resolveMustAnswerTarget(state, item.to);
    const question = item.question.trim();
    if (target === null || question.length === 0 || state.agents[target]?.banned) {
      continue;
    }

    const key = `${target}${MUST_ANSWER_SEPARATOR}${question}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ to: target, question });
  }

  return normalized;
}

function parseEpochEvaluation(content: string, state: DiscussState): EpochEvaluation {
  try {
    const parsed = JSON.parse(stripFencedCodeBlock(content)) as unknown;
    const evaluation = EpochEvaluationSchema.parse(parsed);
    return {
      convergence: evaluation.convergence,
      summary: evaluation.summary,
      mustAnswer: normalizeMustAnswerItems(state, evaluation.must_answer),
    };
  } catch {
    return {
      convergence: 0,
      summary: '',
      mustAnswer: [],
    };
  }
}

function mustAnswerText(snapshot: PersistedDiscussSnapshot, agentName: string): string | null {
  const questions = snapshot.runtime.carryForwardMustAnswer
    .map((item) => parseMustAnswerItem(item))
    .filter((item): item is MustAnswerItem => item !== null && item.to === agentName)
    .map((item) => item.question.trim())
    .filter((question) => question.length > 0);

  if (questions.length === 0) {
    return null;
  }

  if (questions.length === 1) {
    return questions[0] ?? null;
  }

  return questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
}

function buildFollowUpPrompt(state: DiscussState, agentName: string, question: string): string {
  const agent = state.agents[agentName];
  const speakerLabel = agent?.display_name ?? agentName;
  return [
    `Discussion topic:\n${state.topic}`,
    `You are ${speakerLabel} (${agentName}).`,
    'Review the transcript and answer the moderator follow-up.',
    renderTranscriptText(state),
    `Follow-up question:\n${question}`,
  ].join('\n\n');
}

function buildBidBatch(snapshot: PersistedDiscussSnapshot, outcomes: BidOutcome[]): DiscussDomainEvent[] {
  if (snapshot.state.status !== 'bidding') {
    return [];
  }

  let working = snapshot;
  const events: DiscussDomainEvent[] = [];
  let nextSeq = snapshot.lastAppliedSeq + 1;
  const expelAgents: string[] = [];
  const answeredAgents = new Set<string>();

  for (const outcome of outcomes) {
    const bidDecision = decideBid(
      working.state,
      outcome.agentName,
      outcome.score,
      outcome.thought,
      snapshot.sessionId,
      snapshot.projectRoot,
      snapshot.state.topic,
      nextSeq,
      nowIsoString(),
    );

    if (!bidDecision.ok) {
      if (bidDecision.error === 'already_bid' || bidDecision.error === 'agent_not_found') {
        continue;
      }
      return [];
    }

    events.push(...bidDecision.value);
    working = applyEventsLocally(working, bidDecision.value);
    nextSeq += bidDecision.value.length;

    if (outcome.shouldExpel && !working.state.agents[outcome.agentName]?.banned) {
      expelAgents.push(outcome.agentName);
    }
    if (outcome.answeredCarryForward) {
      answeredAgents.add(outcome.agentName);
    }
  }

  if (expelAgents.length > 0) {
    const expelEvents = unwrapResult(
      decideExpel(
        working.state,
        expelAgents,
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        nextSeq,
        nowIsoString(),
      ),
    );
    events.push(...expelEvents);
    working = applyEventsLocally(working, expelEvents);
    nextSeq += expelEvents.length;
  }

  if (answeredAgents.size > 0 && snapshot.runtime.carryForwardMustAnswer.length > 0) {
    const remaining = snapshot.runtime.carryForwardMustAnswer.filter((item) => {
      const decoded = parseMustAnswerItem(item);
      return decoded === null || !answeredAgents.has(decoded.to);
    });

    if (remaining.length !== snapshot.runtime.carryForwardMustAnswer.length) {
      const clearEvent = makeEvent(
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        nextSeq,
        'must_answer.carry_forward.set',
        nowIsoString(),
        { items: remaining },
      );
      events.push(clearEvent);
      working = reduceDiscussEvent(working, clearEvent);
      nextSeq += 1;
    }
  }

  const hadExistingBid = Object.values(snapshot.state.current_bids).some((value) => value !== null);
  const allPendingAgentsFailed = outcomes.length > 0 && outcomes.every((outcome) => outcome.executionFailure);

  if (!hadExistingBid && allPendingAgentsFailed) {
    const endEvents = unwrapResult(
      decideEnd(
        working.state,
        { endReason: 'no_participants' },
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        nextSeq,
        nowIsoString(),
      ),
    );
    events.push(...endEvents);
  }

  return events;
}

async function collectBidOutcome(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
  agentName: string,
  callerCtx: CallerContext,
): Promise<BidOutcome> {
  const run = currentAgentRun(snapshot, agentName, DEFAULT_DISCUSS_PROVIDER, undefined);
  const priorSpeech = lastSpeech(snapshot.state.transcript);
  const priorSpeechForAgent = priorSpeech !== null && priorSpeech.speaker !== agentName ? priorSpeech : null;
  const mustAnswer = mustAnswerText(snapshot, agentName);
  const basePrompt = buildBidPrompt({
    selfName: agentName,
    state: snapshot.state,
    priorSpeech: priorSpeechForAgent,
    mustAnswer,
  });
  const instruction =
    run.executionSessionId === undefined
      ? buildFirstTurnInstruction({
          selfName: agentName,
          state: snapshot.state,
          priorSpeech: priorSpeechForAgent,
          mustAnswer,
        })
      : CONTINUE_TURN_INSTRUCTION;

  const latestRun = loadAttachedOrPersistedSnapshot(ctx, sessionId)?.runtime.agentRuns[agentName] ?? run;
  if (
    latestRun.currentJobId === undefined &&
    latestRun.lastAttemptOutcome === 'retryable_parse_error' &&
    (latestRun.currentAttempt ?? 0) >= MAX_BID_ATTEMPTS
  ) {
    return {
      agentName,
      score: 0,
      thought: '',
      executionFailure: false,
      shouldExpel: false,
      answeredCarryForward: false,
    };
  }

  let prompt = basePrompt;

  while (true) {
    const attempt = await executeAgentAttempt(ctx, {
      agentName,
      sessionId,
      provider: run.provider,
      model: normalizeModel(run.model),
      prompt,
      instruction,
      cwd: ctx.projectRoot,
      callerCtx,
      purpose: PURPOSE_BID,
      timeoutMs: BID_ATTEMPT_TIMEOUT_MS,
    });

    if (!isAttemptSuccess(attempt)) {
      return {
        agentName,
        score: 0,
        thought: '',
        executionFailure: true,
        shouldExpel:
          loadAttachedOrPersistedSnapshot(ctx, sessionId)?.state.agents[agentName]?.participation === 'required',
        answeredCarryForward: false,
      };
    }

    if (attempt.nonResumable) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'non_resumable',
      });
      return {
        agentName,
        score: 0,
        thought: '',
        executionFailure: true,
        shouldExpel: snapshot.state.agents[agentName]?.participation === 'required',
        answeredCarryForward: false,
      };
    }

    try {
      const bid = parseBidResponse(attempt.content);
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'completed',
      });
      return {
        agentName,
        score: bid.score,
        thought: bid.thought,
        executionFailure: false,
        shouldExpel: false,
        answeredCarryForward: mustAnswer !== null,
      };
    } catch (error: unknown) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'retryable_parse_error',
      });

      if (attempt.attempt >= MAX_BID_ATTEMPTS) {
        return {
          agentName,
          score: 0,
          thought: '',
          executionFailure: false,
          shouldExpel: false,
          answeredCarryForward: false,
        };
      }

      const failure = errorMessage(error);
      prompt = buildBidRetryPrompt(basePrompt, attempt.content, failure);
    }
  }
}

async function collectFollowUpAnswer(
  ctx: DiscussContext,
  sessionId: string,
  item: FollowUpQueueItem,
  callerCtx: CallerContext,
): Promise<string> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot) {
    return '';
  }

  const run = currentAgentRun(snapshot, item.agent, DEFAULT_DISCUSS_PROVIDER, undefined);
  const latestRun = snapshot.runtime.agentRuns[item.agent] ?? run;
  if (
    latestRun.currentJobId === undefined &&
    latestRun.lastAttemptOutcome === 'retryable_parse_error' &&
    (latestRun.currentAttempt ?? 0) >= MAX_FOLLOW_UP_ATTEMPTS
  ) {
    return '';
  }

  const basePrompt = buildFollowUpPrompt(snapshot.state, item.agent, item.question);
  let prompt = basePrompt;

  while (true) {
    const attempt = await executeAgentAttempt(ctx, {
      agentName: item.agent,
      sessionId,
      provider: run.provider,
      model: normalizeModel(run.model),
      prompt,
      instruction: FOLLOW_UP_TURN_INSTRUCTION,
      cwd: ctx.projectRoot,
      callerCtx,
      purpose: PURPOSE_FOLLOW_UP,
      timeoutMs: SPEECH_TIMEOUT_MS,
    });

    if (!isAttemptSuccess(attempt)) {
      return attempt.message;
    }

    if (attempt.nonResumable) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: item.agent,
        purpose: PURPOSE_FOLLOW_UP,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'non_resumable',
      });
      return '';
    }

    const answer = normalizeFollowUpAnswer(attempt.content);
    if (answer.length > 0) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: item.agent,
        purpose: PURPOSE_FOLLOW_UP,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'completed',
      });
      return answer;
    }

    await recordJobFinished(ctx, {
      sessionId,
      agentName: item.agent,
      purpose: PURPOSE_FOLLOW_UP,
      jobId: attempt.jobId,
      attempt: attempt.attempt,
      outcome: 'retryable_parse_error',
    });
    if (attempt.attempt >= MAX_FOLLOW_UP_ATTEMPTS) {
      return '';
    }
    prompt = buildFollowUpRetryPrompt(basePrompt, attempt.content, 'Empty answer');
  }
}

export async function collectBids(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'bidding') {
    return { shouldResume: false };
  }

  const bidders = Object.entries(snapshot.state.current_bids)
    .filter(
      ([agentName, score]) =>
        score === null && !snapshot.state.agents[agentName]?.banned && !isManualParticipant(snapshot, agentName),
    )
    .map(([agentName]) => agentName);

  if (bidders.length === 0) {
    return { shouldResume: false };
  }

  const outcomes = await Promise.all(
    bidders.map((agentName) => collectBidOutcome(ctx, sessionId, snapshot, agentName, callerCtx)),
  );

  const committed = await commitDecision(ctx, sessionId, (current) => ({
    ok: true,
    value: buildBidBatch(current, outcomes),
  }));
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  return { shouldResume: committed.ok };
}

export async function collectSpeech(
  ctx: DiscussContext,
  sessionId: string,
  winnerName: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'speaking' || snapshot.state.current_speaker !== winnerName) {
    return { shouldResume: false };
  }

  const agentRun = currentAgentRun(snapshot, winnerName, DEFAULT_DISCUSS_PROVIDER, undefined);
  const prompt = buildSpeechPrompt({
    selfName: winnerName,
    state: snapshot.state,
    priorSpeech: null,
  });

  const attempt = await executeAgentAttempt(ctx, {
    agentName: winnerName,
    sessionId,
    provider: agentRun.provider,
    model: normalizeModel(agentRun.model),
    prompt,
    instruction: CONTINUE_TURN_INSTRUCTION,
    cwd: ctx.projectRoot,
    callerCtx,
    purpose: PURPOSE_SPEECH,
    timeoutMs: SPEECH_TIMEOUT_MS,
  });

  if (!isAttemptSuccess(attempt) || attempt.nonResumable) {
    if (isAttemptSuccess(attempt)) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: winnerName,
        purpose: PURPOSE_SPEECH,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'non_resumable',
      });
    }
    const committed = await commitDecision(ctx, sessionId, (current) =>
      decideSpeechTimeout(
        current.state,
        sessionId,
        ctx.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ),
    );
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
    return { shouldResume: committed.ok };
  }

  await recordJobFinished(ctx, {
    sessionId,
    agentName: winnerName,
    purpose: PURPOSE_SPEECH,
    jobId: attempt.jobId,
    attempt: attempt.attempt,
    outcome: 'completed',
  });
  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideSpeech(
      current.state,
      winnerName,
      attempt.content,
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      current.lastAppliedSeq + 1,
      nowIsoString(),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }
  return { shouldResume: committed.ok };
}

export async function evaluateEpoch(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<EpochEvaluation> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot) {
    return {
      convergence: 0,
      summary: '',
      mustAnswer: [],
    };
  }

  const prompt = [
    'Review the discussion transcript and provide an evaluation:',
    '',
    renderTranscriptText(snapshot.state),
    '',
    'Respond with ONLY valid JSON (no code fences):',
    '{"convergence": 0-10, "summary": "...", "must_answer": [{"to": "agent-name", "question": "..."}]}',
    '',
    'convergence: 0=highly divergent, 10=fully converged',
    'summary: brief synthesis of key positions and progress',
    'must_answer: list of critical questions that need answers before convergence',
  ].join('\n');

  try {
    const result = await runFacilitatorTurn(ctx, {
      sessionId,
      prompt,
      instruction:
        'You are evaluating convergence in a discussion. Return only valid JSON that matches the requested schema.',
      callerCtx,
      timeoutMs: EPOCH_EVAL_TIMEOUT_MS,
      purpose: PURPOSE_EPOCH_EVALUATION,
    });
    return parseEpochEvaluation(result.content, snapshot.state);
  } catch {
    return {
      convergence: 0,
      summary: '',
      mustAnswer: [],
    };
  }
}

export async function handleEpochTransition(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.runtime.controlPhase !== 'evaluate_epoch') {
    return { shouldResume: false };
  }

  const evaluation = await evaluateEpoch(ctx, sessionId, callerCtx);
  const committed = await commitDecision(ctx, sessionId, (current) => {
    if (current.runtime.controlPhase !== 'evaluate_epoch' || current.state.status !== 'bidding') {
      return { ok: true, value: [] };
    }

    const nextSeq = current.lastAppliedSeq + 1;
    const ts = nowIsoString();
    if (evaluation.convergence < CONVERGENCE_THRESHOLD) {
      const summaryEvents = unwrapResult(
        decideEpochSummary(
          current.state,
          evaluation.summary,
          sessionId,
          ctx.projectRoot,
          current.state.topic,
          nextSeq,
          ts,
        ),
      );

      return {
        ok: true,
        value: [
          ...summaryEvents,
          makeEvent(
            sessionId,
            ctx.projectRoot,
            current.state.topic,
            nextSeq + summaryEvents.length,
            'must_answer.carry_forward.set',
            ts,
            {
              items: evaluation.mustAnswer.map(encodeCarryForward),
            },
          ),
        ],
      };
    }

    if (evaluation.mustAnswer.length > 0) {
      return {
        ok: true,
        value: [
          makeEvent(sessionId, ctx.projectRoot, current.state.topic, nextSeq, 'follow_up.queue.set', ts, {
            queue: evaluation.mustAnswer.map((item) => ({
              agent: item.to,
              question: item.question,
            })),
          }),
        ],
      };
    }

    return decideEnd(
      current.state,
      { force: true, reason: 'Discussion converged.' },
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      nextSeq,
      ts,
    );
  });
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  return { shouldResume: committed.ok };
}

export async function runFollowUpTurns(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  while (true) {
    const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
    if (!snapshot || snapshot.runtime.controlPhase !== 'collect_follow_up') {
      return { shouldResume: false };
    }

    const item = snapshot.runtime.followUpQueue[0];
    if (!item) {
      const ended = await commitDecision(ctx, sessionId, (current) =>
        decideEnd(
          current.state,
          { force: true, reason: 'Discussion converged after follow-ups.' },
          sessionId,
          ctx.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          nowIsoString(),
        ),
      );
      if (!ended.ok && ended.error !== 'session_not_found') {
        throw new DiscussManagerError(ended.error, ended.detail);
      }
      return { shouldResume: ended.ok };
    }

    const answer = await collectFollowUpAnswer(ctx, sessionId, item, callerCtx);
    const committed = await commitDecision(ctx, sessionId, (current) => ({
      ok: true,
      value: [
        makeEvent(
          sessionId,
          ctx.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'follow_up.answered',
          nowIsoString(),
          {
            agent: item.agent,
            question: item.question,
            answer,
          },
        ),
      ],
    }));
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }
}

export async function handleSynthesis(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'synthesize') {
    return { shouldResume: false };
  }
  if (ctx.sessions.get(sessionId)?.abortEnded ?? false) {
    return { shouldResume: false };
  }

  const prompt = [
    'Write the final synthesis for this discussion.',
    '',
    renderTranscriptText(snapshot.state),
    '',
    snapshot.state.transcript.some((entry) => entry.type === 'follow_up')
      ? 'The transcript includes moderator follow-up answers. Incorporate them into the final synthesis.'
      : null,
    'Respond with the final synthesis text only. Do not use markdown or code fences.',
  ]
    .filter((section): section is string => section !== null)
    .join('\n');

  try {
    const result = await runFacilitatorTurn(ctx, {
      sessionId,
      prompt,
      instruction: 'You are writing the final synthesis for a discussion. Return only the synthesis text.',
      callerCtx,
      timeoutMs: SPEECH_TIMEOUT_MS,
      purpose: PURPOSE_SYNTHESIS,
    });

    if (result.nonResumable) {
      return { shouldResume: false };
    }

    const committed = await commitDecision(ctx, sessionId, (current) =>
      decideSynthesis(
        current.state,
        result.content,
        sessionId,
        ctx.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ),
    );
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
    detachSession(ctx, sessionId);
    return { shouldResume: false };
  } catch {
    return { shouldResume: false };
  }
}
