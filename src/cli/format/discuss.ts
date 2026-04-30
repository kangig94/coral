import { assertNever } from '../../infra/error-format.js';
import type { BidResult, PersonaAssignment, PersonaSeedOutput, SpeechResult } from '../../discuss/session-types.js';
import type { WatchState } from '../../discuss/watch.js';
import type { DiscussStartResponse } from '../../discuss/read-contract.js';
import { formatUnknown, joinLines } from './text.js';

type DiscussAbortResult = {
  ok: boolean;
  session: string;
};

function formatPersonaAssignment(index: number, assignment: PersonaAssignment): string {
  const positions = Object.entries(assignment.positions)
    .map(([axis, position]) => `${axis}=${position}`)
    .join(' | ');
  const tone = `${assignment.tone.formality}/${assignment.tone.evidence}/${assignment.tone.pace}`;
  const details = [`tone ${tone}`, `seed ${assignment.persona_seed}`];

  if (assignment.shared_position_with !== undefined) {
    details.push(`shared_with ${assignment.shared_position_with}`);
  }

  if (assignment.suggested_origin !== undefined) {
    details.push(`origin ${assignment.suggested_origin}`);
  }

  if (assignment.is_outlier) {
    details.push('outlier');
  }

  return `${index + 1}. ${positions || '(no positions)'}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

function formatDiscussEnded(result: { reason?: string; content?: string }): string {
  const headline = result.reason ? `Session ended: ${result.reason}` : 'Session ended';
  return joinLines([headline, result.content]);
}

function isWatchState(value: WatchState | Record<string, unknown>): value is WatchState {
  return (
    typeof value.session === 'string' &&
    typeof value.status === 'string' &&
    typeof value.topic === 'string' &&
    Number.isInteger(value.epoch) &&
    Number.isInteger(value.step) &&
    Array.isArray(value.events) &&
    Number.isInteger(value.cursor)
  );
}

export function formatPersonaSeed(result: PersonaSeedOutput): string {
  let subsampledLine: string | undefined;
  if (result.subsampled === true) {
    const fromPool = result.original_pool_size === undefined ? '' : ` (from ${result.original_pool_size})`;
    subsampledLine = `Subsampled: yes${fromPool}`;
  } else if (result.subsampled === false) {
    subsampledLine = 'Subsampled: no';
  }

  return joinLines([
    `Seed used: ${result.seed_used}`,
    `Sigma used: ${result.sigma_used}`,
    `Pool size: ${result.pool_size}`,
    subsampledLine,
    result.assignments.length === 0
      ? 'Assignments: none'
      : `Assignments:\n${result.assignments.map((assignment, index) => formatPersonaAssignment(index, assignment)).join('\n')}`,
  ]);
}

export function formatDiscussStart(result: DiscussStartResponse): string {
  return `Session started: ${result.session}`;
}

export function formatDiscussAbort(result: DiscussAbortResult): string {
  return result.ok ? `Session aborted: ${result.session}` : `Abort failed: ${result.session}`;
}

export function formatDiscussParticipate(result: BidResult | SpeechResult): string {
  switch (result.action) {
    case 'speak':
      return 'Your turn to speak';
    case 'listen':
      if (result.speaker === null) {
        return joinLines(['Listen', result.content]);
      }

      return joinLines([`Listen to ${result.speaker}`, result.content]);
    case 'session_ended':
      return formatDiscussEnded(result);
    case 'speech_recorded':
      return 'Speech recorded';
    case 'not_your_turn':
      if (result.current_speaker === null) {
        return 'Not your turn';
      }

      return `Not your turn (current speaker: ${result.current_speaker})`;
    default:
      return assertNever(result);
  }
}

export function formatDiscussWatch(result: WatchState | Record<string, unknown>): string {
  if (!isWatchState(result)) {
    return formatUnknown(result);
  }

  return joinLines([
    `Session ${result.session} [${result.status}]`,
    `Topic: ${result.topic}`,
    `Epoch: ${result.epoch} | Step: ${result.step} | Events: ${result.events.length} | Cursor: ${result.cursor}`,
  ]);
}
