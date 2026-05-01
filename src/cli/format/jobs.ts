import type { CauseRef } from '../../causality/cause-ref.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import { assertNever } from '../../infra/error-format.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { JobStatus, JobTerminal, JobsListResponse } from '../../jobs/records.js';
import type { AcceptedLaunchResponse } from '../../jobs/launch.js';
import { formatTable, joinLines } from './text.js';

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

export type CauseRefDescriber = (ref: CauseRef) => string;

const MAX_INLINE = 10_000;

export function truncatePreview(text: string): string {
  if (text.length <= MAX_INLINE) {
    return text;
  }

  return `${text.slice(0, Math.max(0, MAX_INLINE - 3))}...`;
}

export function pickTerminalPreviewSource(result: JobTerminal, describeCauseRef?: CauseRefDescriber): string {
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
    provider: status.provider ?? status.jobKind,
    cwd: readJobCwd(status),
    age: formatRelativeAge(status.updatedAt, now),
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
