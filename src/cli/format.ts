import { MAX_INLINE } from '../infra/text.js';
import { describeTerminalOutcome, type CauseRef } from '../jobs/outcome.js';
import type { JobsListResponse } from '../transport/http/client.js';
import { assertNever } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import type { BackendStatusFull, ShutdownResult } from '../transport/http/backend-helpers.js';
import type {
  AcceptedLaunchResponse,
  BackendToolHttpError,
  DiscussStartResponse,
  KbDeleteResponse,
  KbMemoResponse,
  KbPromoteResponse,
  KbSourceDeleteResponse,
  KbSourceImportResponse,
  KbUpdateResponse,
} from '../transport/http/client.js';
import type { BidResult, PersonaAssignment, PersonaSeedOutput, SpeechResult } from '../discuss/session-types.js';
import type { WatchState } from '../discuss/watch.js';
import type {
  KbDiagnoseResult,
  KbMemoDeleteResult,
  KbMemoListResult,
  KbMemoPurgeResult,
  KbPrincipleVerboseRow,
  KbPrinciplesResult,
  KbReadResult,
  KbSearchResponse,
  KbSourceListResult,
  ReindexResult,
} from '../kb/entry-types.js';
import type { AbortResult } from '../jobs/abort-result.js';
import type { JobStatus, JobTerminal } from '../jobs/records.js';
import type { WaitStreamEvent } from '../jobs/wait.js';
import type { CliErrorEnvelope } from './errors.js';

type DiscussAbortResult = {
  ok: boolean;
  session: string;
};

type WaitProgressEvent = Extract<WaitStreamEvent, { type: 'progress' }>;
type WaitQueuedEvent = Extract<WaitStreamEvent, { type: 'queued' }>;
type WaitTerminalEvent = Extract<WaitStreamEvent, { type: 'terminal' }>;
type WaitWaitingEvent = Extract<WaitStreamEvent, { type: 'waiting' }>;
type KbReadDisplayResult = KbReadResult & { age?: string };
export type JobsListItem = {
  jobId: string;
  phase: string;
  provider: string;
  cwd: string;
  age: string;
};

export type JobsListDisplayFilters = {
  phase?: string;
  provider?: string;
  all?: boolean;
};

export type WaitRenderContext = {
  isTTY: boolean;
  columns: number;
};

export type CauseRefDescriber = (ref: CauseRef) => string;

function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

function appendCursor(text: string, cursor: string | null): string {
  return cursor === null ? text : `${text} (cursor: ${cursor})`;
}

function normalizeKbWarning(warning: string | undefined, cliPrefix = 'coral-cli'): string | undefined {
  if (warning === undefined || warning.length === 0) {
    return undefined;
  }

  return warning
    .replace(
      /\bkb_search_degraded_until_coordinator_rebuild\b/g,
      'Search index is unavailable; start the Coral backend to rebuild it.',
    )
    .replace(/\bkb_reindex\b/g, () => `${cliPrefix} kb reindex`);
}

function normalizeKbWarnings(
  warnings: string[] | undefined,
  cliPrefix = 'coral-cli',
): string[] | undefined {
  if (warnings === undefined || warnings.length === 0) {
    return undefined;
  }

  return warnings.map((warning) => normalizeKbWarning(warning, cliPrefix) ?? warning);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));

  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  return [formatRow(headers), formatRow(widths.map((width) => '-'.repeat(width))), ...rows.map(formatRow)].join('\n');
}

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

function isVerbosePrincipleRows(
  principles: KbPrinciplesResult['principles'],
): principles is KbPrincipleVerboseRow[] {
  return principles.length > 0 && typeof principles[0] !== 'string';
}

function toKbReadDisplayResult(data: KbReadResult): KbReadDisplayResult {
  if (typeof data.updatedAt !== 'string') {
    return data;
  }

  const ms = Date.now() - Date.parse(data.updatedAt);
  const days = Math.floor(ms / 86_400_000);
  let age: string;

  if (days === 0) {
    age = 'today';
  } else if (days === 1) {
    age = '1 day ago';
  } else {
    age = `${days} days ago`;
  }

  return {
    ...data,
    age,
  };
}

function isBackendToolHttpError(value: unknown): value is BackendToolHttpError {
  return (
    isRecord(value) && typeof value.statusCode === 'number' && 'body' in value && typeof value.message === 'string'
  );
}

function truncatePreview(text: string): string {
  if (text.length <= MAX_INLINE) {
    return text;
  }

  return `${text.slice(0, Math.max(0, MAX_INLINE - 3))}...`;
}

function pickTerminalPreviewSource(result: JobTerminal, describeCauseRef?: CauseRefDescriber): string {
  const content = result.content.trimEnd();
  if (content.length > 0) {
    return content;
  }

  switch (result.outcome.kind) {
    case 'completed':
      return '(empty result)';
    case 'failed':
    case 'job_fault':
    case 'aborted':
      return describeTerminalOutcome(result.outcome, { describeCauseRef });
    case 'provider_exit':
      return `Exited with code ${result.outcome.code}`;
    default:
      return assertNever(result.outcome);
  }
}

function formatRelativeAge(updatedAt: string, now = Date.now()): string {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return 'unknown';
  }

  const deltaMs = Math.max(0, now - updatedMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < minute) {
    return 'just now';
  }

  if (deltaMs < hour) {
    const minutes = Math.floor(deltaMs / minute);
    return `${minutes}m ago`;
  }

  if (deltaMs < day) {
    const hours = Math.floor(deltaMs / hour);
    return `${hours}h ago`;
  }

  const days = Math.floor(deltaMs / day);
  return `${days}d ago`;
}

function readJobCwd(status: JobStatus): string {
  return status.projectRoot;
}

function describeJobsMatch(filters: JobsListDisplayFilters): string {
  const parts = ['current project'];

  if (filters.all === true) {
    parts.push('all phases');
  } else if (filters.phase) {
    parts.push(`phase=${filters.phase}`);
  } else {
    parts.push('live phases');
  }

  if (filters.provider) {
    parts.push(`provider=${filters.provider}`);
  }

  return parts.join(', ');
}

export function formatLaunch(result: AcceptedLaunchResponse): string {
  return `Job ${result.job} ${result.launchState} (session ${result.session})`;
}

export function formatAbortResult(result: AbortResult): string {
  return joinLines([
    result.aborted.length > 0 ? `Aborted jobs: ${result.aborted.join(', ')}` : 'No jobs aborted',
    result.notFound.length > 0 ? `Not found: ${result.notFound.join(', ')}` : undefined,
  ]);
}

export function formatJobsList(data: JobsListResponse, now = Date.now()): JobsListItem[] {
  return data.jobs.map(({ jobId, status }) => ({
    jobId,
    phase: status.phase,
    provider: status.provider,
    cwd: readJobCwd(status),
    age: formatRelativeAge(status.launch.updatedAt, now),
  }));
}

export function renderJobsList(rows: JobsListItem[], filters: JobsListDisplayFilters = {}): string {
  if (rows.length === 0) {
    return `No jobs match ${describeJobsMatch(filters)}`;
  }

  return formatTable(
    ['JOB ID', 'PHASE', 'PROVIDER', 'CWD', 'AGE'],
    rows.map((row) => [row.jobId, row.phase, row.provider, row.cwd, row.age]),
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

/** KB search is consumed by LLM agents, not humans — always return JSON. Do not add text-mode formatting. */
export function formatKbSearch(data: KbSearchResponse, cliPrefix = 'coral-cli'): string {
  const warning = normalizeKbWarning(data.warning, cliPrefix);
  const warnings = normalizeKbWarnings(data.warnings, cliPrefix);
  const results = data.results.map((result) => {
    return {
      note: result.note,
      kind: result.kind,
      title: result.title,
      matched: result.matchedBy,
      snippet: result.snippet ?? '-',
    };
  });

  const output: Record<string, unknown> = {
    results,
    mode: data.mode,
    count: results.length,
  };

  if (data.mode === 'hybrid') {
    output.indicator = '[hybrid]';
  } else if (data.mode === 'vector') {
    output.indicator = '[vector]';
  }

  if (warning !== undefined) {
    output.warning = warning;
  }
  if (warnings !== undefined) {
    output.warnings = warnings;
  }

  return JSON.stringify(output);
}

export function formatKbDiagnose(data: KbDiagnoseResult): string {
  if (data.incidents.length === 0) {
    return 'No incidents need manual repair';
  }

  return data.incidents
    .map((incident) =>
      joinLines([
        `entry_id: ${incident.entry_id}`,
        `locus: ${incident.locus ?? 'null'}`,
        `canonical_incident: ${incident.canonical_incident ?? 'null'}`,
        `repair_hint: ${incident.repair_hint ?? 'null'}`,
        'signals:',
        JSON.stringify(incident.signals ?? null, null, 2),
        `retry_count: ${incident.retry_count}`,
        `retry_not_before: ${incident.retry_not_before}`,
      ]),
    )
    .join('\n\n');
}

export function formatKbPrinciples(data: KbPrinciplesResult, cliPrefix = 'coral-cli'): string {
  const principles = data.principles;
  const warning = normalizeKbWarning(data.warning, cliPrefix);
  let principlesText: string;

  if (!isVerbosePrincipleRows(principles)) {
    principlesText = principles.length === 0 ? 'No principles' : principles.join('\n');
  } else {
    const rows = principles.map((value) => {
      const notes = value.notes.length === 0 ? '' : ` (${value.notes.join(', ')})`;
      return `${value.name}${notes}: ${value.statement}`;
    });

    principlesText = rows.length === 0 ? 'No principles' : rows.join('\n');
  }

  return joinLines([
    principlesText,
    `Total: ${data.total}`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}

export function formatKbRead(data: KbReadResult): string {
  return JSON.stringify(toKbReadDisplayResult(data));
}

export function formatKbMemo(data: KbMemoResponse): string {
  return `Memo: ${data.filename}`;
}

export function formatKbMemoList(data: KbMemoListResult): string {
  const rows = data.memos.map((memo) => [memo.filename, memo.summary, memo.createdAt]);

  if (rows.length === 0) {
    return 'No memos';
  }

  return formatTable(['FILENAME', 'SUMMARY', 'CREATED AT'], rows);
}

export function formatKbMemoDelete(data: KbMemoDeleteResult): string {
  return joinLines([data.deleted.length === 0 ? 'No memos deleted' : data.deleted.join('\n'), `Count: ${data.count}`]);
}

export function formatKbMemoPurge(data: KbMemoPurgeResult): string {
  return `Purged: ${data.deleted} memos`;
}

export function formatKbPromote(data: KbPromoteResponse): string {
  return `Created: ${data.path}`;
}

export function formatKbUpdate(data: KbUpdateResponse): string {
  return `Updated: ${data.path}`;
}

export function formatKbDelete(data: KbDeleteResponse): string {
  return `Deleted: ${data.deleted}`;
}

export function formatKbSourceImport(data: KbSourceImportResponse): string {
  return `Imported: ${data.path}`;
}

export function formatKbSourceList(data: KbSourceListResult): string {
  const rows = data.sources.map((source) => [source.slug, source.title, source.type, source.importedAt]);

  if (rows.length === 0) {
    return 'No sources';
  }

  return formatTable(['SLUG', 'TITLE', 'TYPE', 'IMPORTED AT'], rows);
}

export function formatKbSourceDelete(data: KbSourceDeleteResponse): string {
  return `Deleted: ${data.deleted}`;
}

export function formatKbReindex(data: ReindexResult, cliPrefix = 'coral-cli'): string {
  const warning = normalizeKbWarning(data.warning, cliPrefix);

  return joinLines([
    `Reindexed: ${data.notes} notes, ${data.communities} communities, ${data.principles} principles, ${data.tags} tags (${data.duration_ms}ms, ${data.mode})`,
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
        `Active: ${result.health.active}`,
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
  return result.ok ? 'Backend shutdown initiated' : `Shutdown failed: ${result.reason}`;
}

export function formatErrorEnvelope(
  envelope: CliErrorEnvelope,
  statusCode?: number,
): string {
  const tags = [`code=${envelope.code}`];
  if (statusCode !== undefined) tags.push(`http=${statusCode}`);
  const needsBackendStatusHint =
    envelope.code === 'backend_unreachable'
    && !envelope.message.includes('backend status');
  const message = needsBackendStatusHint
    ? `${envelope.message} Run 'coral-cli backend status' to diagnose.`
    : envelope.message;
  const head = `${message} [${tags.join(', ')}]`;
  if (envelope.detail === undefined) return head;
  return `${head}\nDetail: ${JSON.stringify(envelope.detail)}`;
}

export function formatError(error: unknown): string {
  if (isBackendToolHttpError(error)) {
    const detail = error.body === null || error.body === undefined ? error.message : formatUnknown(error.body);
    return `HTTP ${error.statusCode}: ${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

// Progress messages from the backend workflow runner conventionally start
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

export function formatWaitProgress(event: WaitProgressEvent, label?: string): string {
  if (label === undefined) return event.message;
  return injectProgressLabel(event.message, label);
}

export function formatWaitQueued(event: WaitQueuedEvent, label?: string): string {
  const body = `queued at position ${event.queuePosition}`;
  return label === undefined ? body : `${label} - ${body}`;
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
