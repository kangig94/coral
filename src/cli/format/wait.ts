import { assertNever } from '../../infra/error-format.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import type { JobTerminal } from '../../jobs/records.js';
import type { WaitStreamEvent } from '../../jobs/wait.js';
import { type CauseRefDescriber, pickTerminalPreviewSource, truncatePreview } from './jobs.js';
import { appendCursor, joinLines } from './text.js';
import { formatUsageSegment } from './usage.js';

type WaitProgressEvent = Extract<WaitStreamEvent, { type: 'progress' }>;
type WaitQueuedEvent = Extract<WaitStreamEvent, { type: 'queued' }>;
type WaitTerminalEvent = Extract<WaitStreamEvent, { type: 'terminal' }>;
type WaitCarrierInterruptedEvent = Extract<WaitStreamEvent, { type: 'interrupted' }>;
type WaitWaitingEvent = Extract<WaitStreamEvent, { type: 'waiting' }>;

export type WaitRenderContext = {
  isTTY: boolean;
  columns: number;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const s = String(seconds).padStart(2, ' ');
  const m = String(minutes).padStart(2, ' ');
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${m}m ${s}s`;
}

function formatTimedMessage(elapsedMs: number, message: string, label?: string): string {
  const body = label === undefined ? message : `${label} - ${message}`;
  return `[${formatElapsed(elapsedMs)}] ${body}`;
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

function formatWaitContinuation(jobIds: readonly string[]): string {
  if (jobIds.length === 0) return 'No remaining jobs.';
  return `Run coral-cli wait jobs ${jobIds.join(' ')} to continue waiting.`;
}

export function formatWaitProgress(event: WaitProgressEvent, label?: string): string {
  return formatTimedMessage(event.timing.elapsedMs, event.message, label);
}

export function formatWaitQueued(event: WaitQueuedEvent, label?: string): string {
  const body = `queued at position ${event.queuePosition}`;
  return formatTimedMessage(event.timing.elapsedMs, body, label);
}

export function formatWaitTerminal(
  event: WaitTerminalEvent,
  cursor: string | null,
  inline: boolean,
  options: { describeCauseRef?: CauseRefDescriber; verbose?: boolean } = {},
): string {
  const header = [
    terminalOutcomeHeader(event.jobId, event.result, options.describeCauseRef),
    formatUsageSegment(event.usage, options),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ');
  if (!inline) {
    return joinLines([header, `Result path: ${event.resultPath}`, formatWaitContinuation(event.remainingJobIds)]);
  }

  return joinLines([
    header,
    `Result path: ${event.resultPath}`,
    truncatePreview(pickTerminalPreviewSource(event.result, options.describeCauseRef)),
    cursor === null ? undefined : `Cursor: ${cursor}`,
  ]);
}

/**
 * Reports what was observed without claiming the job ended. The wording is deliberately about the carrier,
 * not the job — "still waiting" stays true, because this event releases nothing and the durable terminal is
 * still the only thing that will end the stream.
 */
export function formatWaitCarrierInterrupted(event: WaitCarrierInterruptedEvent): string {
  // No continuation line, unlike every other event that renders one. Those are printed where this process is
  // about to hand control back, so "run this to continue waiting" names a real next step. This event returns
  // control to nobody — the subscription stays open and the exit code stays pending — so the same line would
  // instruct an action that is not needed, and a caller following it literally would open a second
  // subscription to a stream it is already reading.
  return `Job ${event.jobId} carrier is no longer present (stored phase: ${event.storedPhase}); still waiting for a durable result — this wait is still open, no action needed.`;
}

export function formatWaitWaiting(
  event: WaitWaitingEvent,
  cursor: string | null,
  resumeJobIds: readonly string[] = [],
): string {
  const jobs = event.waitingJobIds.length > 0 ? event.waitingJobIds.join(', ') : 'none';
  const waitingCount = event.waitingJobIds.length;
  const status =
    resumeJobIds.length > 0 && waitingCount > 0
      ? `Still waiting on ${waitingCount} ${waitingCount === 1 ? 'job' : 'jobs'}.`
      : `Still waiting; jobs: ${jobs}.`;
  const resumeArgs = resumeJobIds.length > 0 ? ` ${resumeJobIds.join(' ')}` : '';
  // Named as unconfirmed rather than folded into the waiting list: these are the jobs nothing could answer
  // for, and a reader deciding whether to keep waiting needs that distinction.
  const unknown =
    event.carrierUnknownJobIds === undefined
      ? undefined
      : `Carrier unconfirmed for: ${event.carrierUnknownJobIds.join(', ')}.`;

  return appendCursor(
    joinLines([`${status} Run coral-cli wait jobs${resumeArgs} again to continue waiting.`, unknown]),
    cursor,
  );
}

export function renderWaitLine(text: string, ctx: WaitRenderContext): string {
  const columns = typeof ctx.columns === 'number' && ctx.columns > 0 ? ctx.columns : 80;

  if (!ctx.isTTY) {
    return `${text}\n`;
  }

  return `\r${text.padEnd(columns)}`;
}
