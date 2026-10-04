import { formatResultAvailability } from './result-availability.js';
import type { WaitSnapshot } from '../../jobs/wait/session.js';
import { serializeWaitCursor } from '../../jobs/wait/cursor.js';
import { assertNever } from '../../infra/error-format.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import type { JobTerminal } from '../../jobs/records.js';
import type { WaitStreamEvent } from '../../jobs/wait/contract.js';
import {
  type CauseRefDescriber,
  pickTerminalPreviewSource,
  truncatePreview,
  renderJobsOperatorCommand,
} from './jobs.js';
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

export function formatWaitContinuation(jobIds: readonly string[], cursor: string | null, now = false): string {
  if (jobIds.length === 0) return 'No remaining jobs.';
  return `Run coral-cli wait jobs ${jobIds.join(' ')}${now ? ' --now' : ''}${cursor === null ? '' : ` --cursor ${cursor}`} to continue waiting.`;
}

export function formatWaitProgress(event: WaitProgressEvent, label?: string): string {
  return formatTimedMessage(event.timing.elapsedMs, event.message, label);
}

export function formatWaitQueued(event: WaitQueuedEvent, label?: string): string {
  const body = `queued at position ${event.queuePosition}`;
  return formatTimedMessage(event.timing.elapsedMs, body, label);
}

function frameWaitContent(content: string): string {
  return content
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((line) => `> ${line}`)
    .join('\n');
}

export function formatWaitTerminal(
  event: WaitTerminalEvent,
  cursor: string | null,
  inline: boolean,
  options: { describeCauseRef?: CauseRefDescriber; verbose?: boolean; label?: string } = {},
): string {
  const header = [
    terminalOutcomeHeader(options.label ?? event.jobId, event.result, options.describeCauseRef),
    formatUsageSegment(event.usage, options),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ')
    .replace(/\r\n|[\r\n\u2028\u2029]/g, '\n> ');
  const continuation = formatWaitContinuation(event.remainingJobIds, cursor);
  const fullDetail =
    (event.version === 'jobs.wait.v3' && event.availability?.kind !== 'available') ||
    (inline && event.result.content.length > 10_000)
      ? `Full retained outcome: ${renderJobsOperatorCommand({ kind: 'jobs-detail-full', jobId: event.jobId })}`
      : undefined;
  if (!inline) {
    return joinLines([
      header,
      fullDetail,
      event.version === 'jobs.wait.v3' && event.availability
        ? formatResultAvailability(event.availability)
        : `Unverified result path: ${event.resultPath}`,
      continuation,
    ]);
  }

  return joinLines([
    header,
    fullDetail,
    event.version === 'jobs.wait.v3' && event.availability
      ? formatResultAvailability(event.availability)
      : `Unverified result path: ${event.resultPath}`,
    frameWaitContent(truncatePreview(pickTerminalPreviewSource(event.result, options.describeCauseRef))),
    continuation,
    cursor === null ? undefined : `Cursor: ${cursor}`,
  ]);
}

export function formatWaitCarrierInterrupted(event: WaitCarrierInterruptedEvent): string {
  return `Job ${event.jobId} carrier is no longer present (stored phase: ${event.storedPhase}); still waiting for a durable result — this wait is still open, no action needed.`;
}

export function formatWaitWaiting(
  event: WaitWaitingEvent,
  cursor: string | null,
  resumeJobIds: readonly string[] = event.waitingJobIds,
): string {
  const jobs = event.waitingJobIds.length > 0 ? event.waitingJobIds.join(', ') : 'none';
  const waitingCount = event.waitingJobIds.length;
  const status =
    resumeJobIds.length > 0 && waitingCount > 0
      ? `Still waiting on ${waitingCount} ${waitingCount === 1 ? 'job' : 'jobs'}.`
      : `Still waiting; jobs: ${jobs}.`;
  const continuation =
    resumeJobIds.length > 0
      ? ` Run coral-cli wait jobs ${resumeJobIds.join(' ')}${cursor === null ? '' : ` --cursor ${cursor}`} to continue waiting.`
      : '';
  const unknown =
    event.carrierUnknownJobIds === undefined
      ? undefined
      : `Carrier unconfirmed for: ${event.carrierUnknownJobIds.join(', ')}.`;

  return joinLines([appendCursor(`${status}${continuation}`, cursor), unknown]);
}

export function renderWaitLine(text: string, ctx: WaitRenderContext): string {
  const columns = typeof ctx.columns === 'number' && ctx.columns > 0 ? ctx.columns : 80;

  if (!ctx.isTTY) {
    return `${text}\n`;
  }

  return `\r${text.padEnd(columns)}`;
}

export function formatWaitSnapshot(snapshot: WaitSnapshot): string {
  const blocks = snapshot.jobs.map((job) => {
    const header =
      job.disposition !== 'admitted'
        ? `Job ${job.jobId}: ${job.disposition}${job.message ? ` — ${job.message}` : ''}`
        : job.terminal || job.alreadyCollected
          ? `Job ${job.jobId}: terminal${job.alreadyCollected ? '/already collected' : ''}`
          : `Job ${job.jobId}: ${job.phase ?? 'nonterminal'}`;
    const terminal = job.terminal;
    return joinLines([
      header,
      ...job.progress,
      terminal
        ? `Outcome: ${terminal.outcomeKind}; exit ${terminal.exitCode}; duration ${terminal.durationMs} ms`
        : undefined,
      terminal ? `Content preview:\n${frameWaitContent(terminal.contentPreview)}` : undefined,
      terminal?.contentOmittedBytes ? `Content omitted: ${terminal.contentOmittedBytes} bytes` : undefined,
      terminal ? `Diagnostic preview:\n${frameWaitContent(terminal.diagnosticPreview)}` : undefined,
      terminal?.diagnosticOmittedBytes ? `Diagnostics omitted: ${terminal.diagnosticOmittedBytes} bytes` : undefined,
      job.availability && (!job.alreadyCollected || job.artifactFollowUp)
        ? formatResultAvailability(job.availability, job.artifactFollowUp)
        : undefined,
      terminal &&
      (terminal.contentOmittedBytes > 0 ||
        terminal.diagnosticOmittedBytes > 0 ||
        job.availability?.kind !== 'available')
        ? `Full retained outcome: ${renderJobsOperatorCommand({ kind: 'jobs-detail-full', jobId: job.jobId })}`
        : undefined,
    ]);
  });
  return joinLines([
    ...snapshot.notices,
    ...blocks,
    snapshot.remainingJobIds.length
      ? formatWaitContinuation(snapshot.remainingJobIds, serializeWaitCursor(snapshot.cursor), true)
      : undefined,
  ]);
}
