import { z } from 'zod';

import { errorMessage } from '../../shared/utils.js';
import { type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../events.js';
import { reduceDiscussEvent } from '../reducer.js';
import { resolveAgentName } from '../state-machine.js';
import type { DiscussState, TranscriptEntry } from '../types.js';
import { renderEntries, renderHeader } from '../transcript.js';
import { nowIsoString } from '../util/time.js';
import type { DiscussContext } from './context.js';

export const BID_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;
export const SPEECH_TIMEOUT_MS = 5 * 60 * 1000;
export const EPOCH_EVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const CONVERGENCE_THRESHOLD = 7;
export const MAX_BID_ATTEMPTS = 3;
export const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MUST_ANSWER_SEPARATOR = '\u0000';

const bidSchema = z.object({
  score: z.number().int().min(0).max(100),
  thought: z.string(),
});

const epochEvaluationSchema = z.object({
  convergence: z.number().min(0).max(10),
  summary: z.string(),
  must_answer: z.array(
    z.object({
      to: z.string(),
      question: z.string(),
    }),
  ),
});

export type MustAnswerItem = {
  to: string;
  question: string;
};

export type EpochEvaluation = {
  convergence: number;
  summary: string;
  mustAnswer: MustAnswerItem[];
};

export type BidOutcome = {
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

export function failedBidOutcome(
  agentName: string,
  options: {
    executionFailure: boolean;
    shouldExpel?: boolean;
    answeredCarryForward?: boolean;
  },
): BidOutcome {
  return {
    agentName,
    score: 0,
    thought: '',
    executionFailure: options.executionFailure,
    shouldExpel: options.shouldExpel ?? false,
    answeredCarryForward: options.answeredCarryForward ?? false,
  };
}

export function ctxTs(ctx: DiscussContext): string {
  return nowIsoString(ctx.runtime.time);
}

export function emptyEpochEvaluation(): EpochEvaluation {
  return {
    convergence: 0,
    summary: '',
    mustAnswer: [],
  };
}

function stripFencedCodeBlock(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function buildBidRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return ONLY valid JSON in this exact shape: {"score": 0-100, "thought": "..."}',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

export function buildFollowUpRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return only the answer text. Do not use markdown or code fences.',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

export function parseBidResponse(content: string): { score: number; thought: string } {
  const parsed = JSON.parse(stripFencedCodeBlock(content));
  return bidSchema.parse(parsed);
}

export function normalizeFollowUpAnswer(content: string): string {
  return stripFencedCodeBlock(content).trim();
}

export function lastSpeech(transcript: TranscriptEntry[]): { speaker: string; content: string } | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.type === 'speech') {
      return { speaker: entry.agent, content: entry.content };
    }
  }
  return null;
}

export function renderTranscriptText(state: DiscussState): string {
  return `${renderHeader(state.topic, state.agents)}${renderEntries(state.transcript, state.agents)}`;
}

export function applyEventsLocally(
  snapshot: PersistedDiscussSnapshot,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return events.reduce((current, event) => reduceDiscussEvent(current, event), snapshot);
}

export function encodeCarryForward(item: MustAnswerItem): string {
  return `${item.to}${MUST_ANSWER_SEPARATOR}${item.question}`;
}

export function parseMustAnswerItem(value: string): MustAnswerItem | null {
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
  items: z.infer<typeof epochEvaluationSchema>['must_answer'],
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

export function parseEpochEvaluation(content: string, state: DiscussState): EpochEvaluation {
  try {
    const parsed = JSON.parse(stripFencedCodeBlock(content)) as unknown;
    const evaluation = epochEvaluationSchema.parse(parsed);
    return {
      convergence: evaluation.convergence,
      summary: evaluation.summary,
      mustAnswer: normalizeMustAnswerItems(state, evaluation.must_answer),
    };
  } catch {
    return emptyEpochEvaluation();
  }
}

export function mustAnswerText(snapshot: PersistedDiscussSnapshot, agentName: string): string | null {
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

export function buildFollowUpPrompt(state: DiscussState, agentName: string, question: string): string {
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

export function formatTurnParseError(error: unknown): string {
  return errorMessage(error);
}
