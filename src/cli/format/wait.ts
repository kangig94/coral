import { encodeWaitAllOutcome, type WaitAllOutcome } from '../wait-all-outcome.js';
import { formatRecoveryQuarantineCommand } from './backend.js';
import { waitCommandPrefix } from '../../coordinator/handoff-routing/wait-command.js';
export { waitCommandPrefix } from '../../coordinator/handoff-routing/wait-command.js';
import { formatResultAvailability } from './result-availability.js';
import type { WaitSnapshot } from '../../jobs/wait/session.js';
import { assertNever } from '../../infra/error-format.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import type { JobTerminal } from '../../jobs/records.js';
import { isFinalWaitEvent, type WaitStreamEvent } from '../../jobs/wait/contract.js';
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
  return `[${formatElapsed(elapsedMs)}] ${body.replace(/\r\n|[\r\n\u2028\u2029]/g, '\n> ')}`;
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

/** A continuation keeps its wait's mode flag, so running it resumes the same kind of wait. */
export type WaitContinuationMode = 'stream' | 'snapshot' | 'all';

const CONTINUATION_MODE_FLAG = {
  stream: '',
  snapshot: ' --snapshot',
  all: ' --all',
} as const satisfies Record<WaitContinuationMode, string>;

export function waitContinuationCommand(
  jobIds: readonly string[],
  cursor: string | null,
  mode: WaitContinuationMode,
  allOutcome?: WaitAllOutcome,
): string {
  const outcomeFlag = allOutcome === undefined ? '' : ` --all-outcome ${encodeWaitAllOutcome(allOutcome)}`;
  return `${waitCommandPrefix()} ${jobIds.join(' ')}${CONTINUATION_MODE_FLAG[mode]}${outcomeFlag}${cursor === null ? '' : ` --cursor ${cursor}`}`;
}

export function formatWaitContinuation(
  jobIds: readonly string[],
  cursor: string | null,
  mode: WaitContinuationMode = 'stream',
  allOutcome?: WaitAllOutcome,
): string {
  if (jobIds.length === 0) return 'No remaining jobs.';
  return `Run ${waitContinuationCommand(jobIds, cursor, mode, allOutcome)} to continue waiting.`;
}

export function formatWaitProgress(event: WaitProgressEvent, label?: string): string {
  return formatTimedMessage(event.timing.elapsedMs, event.message, label);
}

export function formatWaitQueued(event: WaitQueuedEvent, label?: string): string {
  const body = `queued at position ${event.queuePosition}${event.reason === undefined ? '' : ` (${event.reason})`}`;
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
  options: {
    describeCauseRef?: CauseRefDescriber;
    verbose?: boolean;
    label?: string;
    continuationMode?: WaitContinuationMode;
    allOutcome?: WaitAllOutcome;
  } = {},
): string {
  const header = [
    terminalOutcomeHeader(
      `${options.label ?? event.jobId}${event.execution === undefined ? '' : ` execution #${event.execution}`}`,
      event.result,
      options.describeCauseRef,
    ),
    event.outsideCwdWorkDir === undefined ? undefined : `Work dir: ${JSON.stringify(event.outsideCwdWorkDir)}`,
    formatUsageSegment(event.usage, options),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ')
    .replace(/\r\n|[\r\n\u2028\u2029]/g, '\n> ');
  // A terminal that ends nothing leaves the continuation to the event that ends the read.
  const continuation = isFinalWaitEvent(event)
    ? formatWaitContinuation(event.remainingJobIds, cursor, options.continuationMode, options.allOutcome)
    : undefined;
  const fullDetail =
    event.availability.kind !== 'available' || (inline && event.result.content.length > 10_000)
      ? `Full retained outcome: ${renderJobsOperatorCommand({ kind: 'jobs-detail-full', jobId: event.jobId })}`
      : undefined;
  if (!inline) {
    return joinLines([header, fullDetail, formatResultAvailability(event.availability), continuation]);
  }

  return joinLines([
    header,
    fullDetail,
    formatResultAvailability(event.availability),
    frameWaitContent(truncatePreview(pickTerminalPreviewSource(event.result, options.describeCauseRef))),
    continuation,
    continuation === undefined || cursor === null || event.remainingJobIds.length === 0
      ? undefined
      : `Cursor: ${cursor}`,
  ]);
}

export function formatWaitCarrierInterrupted(event: WaitCarrierInterruptedEvent): string {
  return `Job ${event.jobId} carrier is no longer present (stored phase: ${event.storedPhase}); still waiting for a durable result — this wait is still open, no action needed.`;
}

export function formatWaitWaiting(
  event: Pick<WaitWaitingEvent, 'type' | 'waitingJobIds' | 'carrierUnknownJobIds' | 'carrierAbsentJobIds'>,
  cursor: string | null,
  resumeJobIds: readonly string[] = event.waitingJobIds,
  continuationMode: WaitContinuationMode = 'stream',
  allOutcome?: WaitAllOutcome,
): string {
  if (resumeJobIds.length === 0) return 'Wait complete; no jobs remain.';
  const waitingCount = event.waitingJobIds.length;
  const status =
    resumeJobIds.length > 0 && waitingCount > 0
      ? `Still waiting on ${waitingCount} ${waitingCount === 1 ? 'job' : 'jobs'}.`
      : 'Wait complete; no jobs remain.';
  const continuation = ` ${formatWaitContinuation(resumeJobIds, cursor, continuationMode, allOutcome)}`;
  const unknown = !event.carrierUnknownJobIds?.length
    ? undefined
    : `Carrier unconfirmed for: ${event.carrierUnknownJobIds.join(', ')}.`;

  const absent = !event.carrierAbsentJobIds?.length
    ? undefined
    : `Carrier absent for: ${event.carrierAbsentJobIds.join(', ')}.`;

  return joinLines([appendCursor(`${status}${continuation}`, cursor), unknown, absent]);
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
        : `Job ${job.jobId}${job.execution === undefined ? '' : ` execution #${job.execution}`}: ${job.terminal ? 'terminal' : (job.phase ?? 'nonterminal')}`;
    const terminal = job.terminal;
    return joinLines([
      job.outsideCwdWorkDir === undefined ? header : `${header} · Work dir: ${JSON.stringify(job.outsideCwdWorkDir)}`,
      job.finishingStatus === undefined
        ? undefined
        : `Finishing: ${job.finishingStatus.kind}; ${job.finishingStatus.reason}; successor=${job.finishingStatus.successor}.`,
      job.finishingStatus?.kind === 'blocked' ? formatRecoveryQuarantineCommand({ kind: 'list' }) : undefined,
      ...job.progress.map(frameWaitContent),
      terminal
        ? `Outcome: ${terminal.outcomeKind}; exit ${terminal.exitCode}; duration ${terminal.durationMs} ms`
        : undefined,
      terminal ? `Content preview:\n${frameWaitContent(terminal.contentPreview)}` : undefined,
      terminal?.contentOmitted ? 'Content omitted from preview.' : undefined,
      terminal ? `Diagnostic preview:\n${frameWaitContent(terminal.diagnosticPreview)}` : undefined,
      terminal?.diagnosticOmitted ? 'Diagnostics omitted from preview.' : undefined,
      job.availability ? formatResultAvailability(job.availability) : undefined,
      terminal && (terminal.contentOmitted || terminal.diagnosticOmitted || job.availability?.kind !== 'available')
        ? `Full retained outcome: ${renderJobsOperatorCommand({ kind: 'jobs-detail-full', jobId: job.jobId })}`
        : undefined,
    ]);
  });
  return joinLines([
    ...snapshot.notices,
    ...blocks,
    snapshot.remainingJobIds.length
      ? formatWaitContinuation(snapshot.remainingJobIds, snapshot.cursor, 'snapshot')
      : undefined,
  ]);
}
