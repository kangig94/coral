import { assertNever } from '../../infra/error-format.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import type { JobTerminal } from '../../jobs/records.js';
import type { WaitStreamEvent } from '../../jobs/wait.js';
import { type CauseRefDescriber, pickTerminalPreviewSource, truncatePreview } from './jobs.js';
import { appendCursor, joinLines } from '../../infra/text.js';

type WaitProgressEvent = Extract<WaitStreamEvent, { type: 'progress' }>;
type WaitQueuedEvent = Extract<WaitStreamEvent, { type: 'queued' }>;
type WaitTerminalEvent = Extract<WaitStreamEvent, { type: 'terminal' }>;
type WaitWaitingEvent = Extract<WaitStreamEvent, { type: 'waiting' }>;

export type WaitRenderContext = {
  isTTY: boolean;
  columns: number;
};

// Progress messages from the coordinator workflow runner conventionally start
// with a time bracket like "[ 0m  2s] 0-arc ...". When a caller needs to
// attribute an event to one of several jobs, we insert "<label> - " AFTER
// the closing time bracket so the time stays first. Messages without a
// leading bracket fall back to a plain "<label> - <message>" prefix.
const TIME_BRACKET_RE = /^(\[[^\]]*\])\s+([\s\S]*)$/;

function injectProgressLabel(message: string, label: string): string {
  const match = TIME_BRACKET_RE.exec(message);
  if (match === null) return `${label} - ${message}`;
  return `${match[1]} ${label} - ${match[2]}`;
}

function terminalOutcomeHeader(jobId: string, result: JobTerminal, describeCauseRef?: CauseRefDescriber): string {
  switch (result.outcome.kind) {
    case 'completed':
      return `Job ${jobId} completed`;
    case 'aborted':
      return `Job ${jobId} aborted: ${result.outcome.reason}`;
    case 'provider_exit': {
      const base = `Job ${jobId} provider exited ${result.outcome.code}`;
      return result.outcome.note === undefined ? base : `${base}: ${result.outcome.note}`;
    }
    case 'failed':
      return `Job ${jobId} failed: ${describeTerminalOutcome(result.outcome, { describeCauseRef })}`;
    case 'job_fault':
      return `Job ${jobId} errored: ${describeTerminalOutcome(result.outcome, { describeCauseRef })} [${result.outcome.fault.kind}]`;
    default:
      return assertNever(result.outcome);
  }
}

export function formatWaitProgress(event: WaitProgressEvent, label?: string): string {
  if (label === undefined) return event.message;
  return injectProgressLabel(event.message, label);
}

export function formatWaitQueued(event: WaitQueuedEvent, label?: string): string {
  const body = `queued at position ${event.queuePosition}`;
  return label === undefined ? body : `${label} - ${body}`;
}

export function formatWaitTerminal(
  event: WaitTerminalEvent,
  cursor: string | null,
  inline: boolean,
  options: { describeCauseRef?: CauseRefDescriber } = {},
): string {
  const header = terminalOutcomeHeader(event.jobId, event.result, options.describeCauseRef);
  if (!inline) {
    const remaining = event.remainingJobIds.length > 0 ? event.remainingJobIds.join(', ') : 'none';
    return joinLines([
      header,
      `Result path: ${event.resultPath}`,
      `Remaining jobs: ${remaining}`,
      cursor === null ? undefined : `Cursor: ${cursor}`,
    ]);
  }

  return joinLines([
    header,
    `Result path: ${event.resultPath}`,
    truncatePreview(pickTerminalPreviewSource(event.result, options.describeCauseRef)),
    cursor === null ? undefined : `Cursor: ${cursor}`,
  ]);
}

export function formatWaitWaiting(event: WaitWaitingEvent, cursor: string | null): string {
  const jobs = event.waitingJobIds.length > 0 ? event.waitingJobIds.join(', ') : 'none';

  return appendCursor(`Still waiting; jobs: ${jobs}`, cursor);
}

export function renderWaitLine(text: string, ctx: WaitRenderContext): string {
  const columns = typeof ctx.columns === 'number' && ctx.columns > 0 ? ctx.columns : 80;

  if (!ctx.isTTY) {
    return `${text}\n`;
  }

  return `\r${text.padEnd(columns)}`;
}
