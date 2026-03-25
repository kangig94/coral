import { MAX_INLINE } from '../shared/schemas.js';
import { isRecord } from '../shared/mcp-utils.js';
import type { BackendToolHttpError } from '../client/http-client.js';
import type { BackendStatusFull, ShutdownResult } from '../bridge/backend-client.js';
import type {
  BidResult,
  PersonaAssignment,
  PersonaSeedOutput,
  SpeechResult,
} from '../discuss/types.js';
import type { AbortResult } from '../execution/abort-registry.js';
import type { ListResult } from '../execution/service.js';
import type { LaunchDecision, TerminalResult, WaitStreamEvent } from '../types.js';

export type DiscussStartResult = {
  session: string;
};

export type DiscussAbortResult = {
  ok: boolean;
  session: string;
};

type DiscussWatchResult = {
  session: string;
  status: string;
  topic: string;
  epoch: number;
  step: number;
  events: unknown[];
  cursor: number;
};

type WaitProgressEvent = Extract<WaitStreamEvent, { type: 'progress' }>;
type WaitQueuedEvent = Extract<WaitStreamEvent, { type: 'queued' }>;
type WaitTerminalEvent = Extract<WaitStreamEvent, { type: 'terminal' }>;
type WaitTimeoutEvent = Extract<WaitStreamEvent, { type: 'timeout' }>;

export type WaitRenderContext = {
  isTTY: boolean;
  columns: number;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}

function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function appendCursor(text: string, cursor: string | null): string {
  return cursor === null ? text : `${text} (cursor: ${cursor})`;
}

function normalizeKbWarning(warning: unknown, cliPrefix = 'coral-cli'): string | undefined {
  if (typeof warning !== 'string' || warning.length === 0) {
    return undefined;
  }

  return warning.replace(/\bkb_reindex\b/g, () => `${cliPrefix} kb reindex`);
}

function isKbSearchMode(value: unknown): value is 'text' | 'hybrid' {
  return value === 'text' || value === 'hybrid';
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));

  const formatRow = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  return [
    formatRow(headers),
    formatRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(formatRow),
  ].join('\n');
}

function formatPersonaAssignment(index: number, assignment: PersonaAssignment): string {
  const positions = Object.entries(assignment.positions)
    .map(([axis, position]) => `${axis}=${position}`)
    .join(' | ');
  const tone = `${assignment.tone.formality}/${assignment.tone.evidence}/${assignment.tone.pace}`;
  const details = [
    `tone ${tone}`,
    `seed ${assignment.persona_seed}`,
  ];

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

function isDiscussWatchResult(value: unknown): value is DiscussWatchResult {
  return isRecord(value)
    && typeof value.session === 'string'
    && typeof value.status === 'string'
    && typeof value.topic === 'string'
    && Number.isInteger(value.epoch)
    && Number.isInteger(value.step)
    && Array.isArray(value.events)
    && Number.isInteger(value.cursor);
}

function isBackendToolHttpError(value: unknown): value is BackendToolHttpError {
  return isRecord(value)
    && typeof value.statusCode === 'number'
    && 'body' in value
    && typeof value.message === 'string';
}

function truncatePreview(text: string): string {
  if (text.length <= MAX_INLINE) {
    return text;
  }

  return `${text.slice(0, Math.max(0, MAX_INLINE - 3))}...`;
}

function pickTerminalPreviewSource(result: TerminalResult): string {
  const content = result.content.trimEnd();
  if (content.length > 0) {
    return content;
  }

  if (typeof result.notice === 'string' && result.notice.length > 0) {
    return result.notice;
  }

  if (result.aborted) {
    return 'Aborted';
  }

  if (result.exitCode !== undefined && result.exitCode !== null) {
    return `Exited with code ${result.exitCode}`;
  }

  return '(empty result)';
}

export function formatLaunchDecision(result: LaunchDecision): string {
  switch (result.status) {
    case 'running':
      return `Job ${result.job} running (session ${result.session})`;
    case 'queued':
      return `Job ${result.job} queued (session ${result.session})`;
    case 'rejected':
      return `Rejected [${result.code}]: ${result.message}`;
    default:
      return assertNever(result);
  }
}

export function formatAbortResult(result: AbortResult): string {
  return joinLines([
    result.aborted.length > 0
      ? `Aborted jobs: ${result.aborted.join(', ')}`
      : 'No jobs aborted',
    result.notFound.length > 0
      ? `Not found: ${result.notFound.join(', ')}`
      : undefined,
  ]);
}

export function formatProviderList(result: ListResult): string {
  if (result.sessions.length === 0) {
    return 'No sessions';
  }

  const rows = result.sessions.map((session) => [
    session.sessionId,
    session.state,
    session.name || '-',
    session.model || '-',
    session.cwd || '-',
  ]);

  return formatTable(['SESSION', 'STATE', 'NAME', 'MODEL', 'CWD'], rows);
}

export function formatPersonaSeed(result: PersonaSeedOutput): string {
  const subsampledLine = result.subsampled === undefined
    ? undefined
    : result.subsampled
      ? `Subsampled: yes${result.original_pool_size === undefined ? '' : ` (from ${result.original_pool_size})`}`
      : 'Subsampled: no';

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

export function formatDiscussStart(result: DiscussStartResult): string {
  return `Session started: ${result.session}`;
}

export function formatDiscussAbort(result: DiscussAbortResult): string {
  return result.ok
    ? `Session aborted: ${result.session}`
    : `Abort failed: ${result.session}`;
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

export function formatDiscussWatch(result: unknown): string {
  if (!isDiscussWatchResult(result)) {
    return formatUnknown(result);
  }

  return joinLines([
    `Session ${result.session} [${result.status}]`,
    `Topic: ${result.topic}`,
    `Epoch: ${result.epoch} | Step: ${result.step} | Events: ${result.events.length} | Cursor: ${result.cursor}`,
  ]);
}

export function formatKbSearch(data: unknown, cliPrefix = 'coral-cli'): string {
  if (!isRecord(data) || !Array.isArray(data.results) || !isKbSearchMode(data.mode)) {
    return formatUnknown(data);
  }

  const warning = normalizeKbWarning(data.warning, cliPrefix);
  const rows = data.results.map((result) => {
    if (!isRecord(result)) {
      return ['-', '-', '-', '-'];
    }

    const matchedBy = Array.isArray(result.matchedBy)
      ? result.matchedBy.filter((value): value is string => typeof value === 'string')
      : [];

    return [
      typeof result.path === 'string' ? result.path : '-',
      typeof result.title === 'string' ? result.title : '-',
      matchedBy.length > 0 ? matchedBy.join(', ') : '-',
      typeof result.snippet === 'string' ? result.snippet : '-',
    ];
  });

  return joinLines([
    rows.length === 0
      ? 'No results'
      : formatTable(['PATH', 'TITLE', 'MATCHED BY', 'SNIPPET'], rows),
    `Mode: ${data.mode}`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}

export function formatKbPrinciples(data: unknown, cliPrefix = 'coral-cli'): string {
  if (!isRecord(data) || !Array.isArray(data.principles) || typeof data.total !== 'number') {
    return formatUnknown(data);
  }

  const principles = data.principles.filter((value): value is string => typeof value === 'string');
  const warning = normalizeKbWarning(data.warning, cliPrefix);

  return joinLines([
    principles.length === 0 ? 'No principles' : principles.join('\n'),
    `Total: ${data.total}`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}

export function formatKbPromote(data: unknown): string {
  if (!isRecord(data) || typeof data.path !== 'string') {
    return formatUnknown(data);
  }

  return `Created: ${data.path}`;
}

export function formatKbUpdate(data: unknown): string {
  if (!isRecord(data) || typeof data.path !== 'string') {
    return formatUnknown(data);
  }

  return `Updated: ${data.path}`;
}

export function formatKbDelete(data: unknown): string {
  if (!isRecord(data) || typeof data.deleted !== 'string') {
    return formatUnknown(data);
  }

  return `Deleted: ${data.deleted}`;
}

export function formatKbReindex(data: unknown, cliPrefix = 'coral-cli'): string {
  if (
    !isRecord(data)
    || typeof data.notes !== 'number'
    || typeof data.principles !== 'number'
    || typeof data.tags !== 'number'
    || typeof data.duration_ms !== 'number'
    || !isKbSearchMode(data.mode)
  ) {
    return formatUnknown(data);
  }

  const warning = normalizeKbWarning(data.warning, cliPrefix);

  return joinLines([
    formatTable(['NOTES', 'PRINCIPLES', 'TAGS', 'DURATION_MS', 'MODE'], [[
      String(data.notes),
      String(data.principles),
      String(data.tags),
      String(data.duration_ms),
      data.mode,
    ]]),
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}

export function formatBackendStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return joinLines([
        'Backend ok',
        `Version: ${result.health.version}`,
        `Uptime: ${result.health.uptimeMs}ms`,
        `Active children: ${result.health.activeChildren}`,
        `Active jobs: ${result.health.activeJobs}`,
      ]);
    case 'not_running':
      return 'Backend not running';
    case 'shutting_down':
      return 'Backend shutting down';
    case 'unauthorized':
      return 'Backend unauthorized';
    default:
      return assertNever(result);
  }
}

export function formatShutdown(result: ShutdownResult): string {
  return result.ok
    ? 'Backend shutdown initiated'
    : `Shutdown failed: ${result.reason}`;
}

export function formatError(error: unknown): string {
  if (isBackendToolHttpError(error)) {
    const detail = error.body == null ? error.message : formatUnknown(error.body);
    return `HTTP ${error.statusCode}: ${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function formatWaitProgress(event: WaitProgressEvent, cursor: string | null): string {
  return appendCursor(`[${event.jobId}] ${event.message}`, cursor);
}

export function formatWaitQueued(event: WaitQueuedEvent, cursor: string | null): string {
  return appendCursor(`[${event.jobId}] queued at position ${event.queuePosition}`, cursor);
}

export function formatWaitTerminal(
  event: WaitTerminalEvent,
  cursor: string | null,
  inline: boolean,
): string {
  if (!inline) {
    return joinLines([
      `[${event.completedJobId}] completed`,
      `Result path: ${event.resultPath}`,
      `Remaining jobs: ${event.remainingJobIds.length}`,
      cursor === null ? undefined : `Cursor: ${cursor}`,
    ]);
  }

  return joinLines([
    `[${event.completedJobId}] completed`,
    truncatePreview(pickTerminalPreviewSource(event.result)),
    cursor === null ? undefined : `Cursor: ${cursor}`,
  ]);
}

export function formatWaitTimeout(event: WaitTimeoutEvent, cursor: string | null): string {
  const running = event.runningJobIds.length > 0
    ? event.runningJobIds.join(', ')
    : 'none';

  return appendCursor(`Wait timed out; running jobs: ${running}`, cursor);
}

export function renderWaitLine(text: string, ctx: WaitRenderContext): string {
  const columns = typeof ctx.columns === 'number' && ctx.columns > 0 ? ctx.columns : 80;

  if (!ctx.isTTY) {
    return `${text}\n`;
  }

  return `\r${text.padEnd(columns)}`;
}
