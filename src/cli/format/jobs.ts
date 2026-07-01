import type { CauseRef } from '../../causality/cause-ref.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import { assertNever } from '../../infra/error-format.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { JobTerminal, JobsListResponse } from '../../jobs/records.js';
import type { AcceptedLaunchResponse } from '../../jobs/launch.js';
import { formatTable, joinLines } from './text.js';

export type JobsListItem = {
  jobId: string;
  phase: string;
  provider: string;
  cwd: string;
  jobKind: string;
  age: string;
};

export type JobsListDisplayFilters = {
  phase?: string;
  provider?: string;
  all?: boolean;
  /** Current working directory, used to surface its jobs as the primary group. */
  cwd?: string;
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

function describeJobsMatch(filters: JobsListDisplayFilters): string {
  const parts: string[] = [];

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

export function formatDetachedLaunchStatus(result: Pick<AcceptedLaunchResponse, 'launchState' | 'session'>): string {
  return `Job ${result.launchState} (session ${result.session})`;
}

export function formatLaunchWaitHint(result: Pick<AcceptedLaunchResponse, 'job'>): string {
  return `Run coral-cli wait jobs ${result.job} to wait for completion.`;
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
    cwd: status.projectRoot,
    jobKind: status.jobKind,
    age: formatRelativeAge(status.updatedAt, now),
  }));
}

const JOBS_TABLE_HEADERS = ['JOB ID', 'PHASE', 'PROVIDER', 'AGE'];

function jobsTable(rows: JobsListItem[]): string {
  return formatTable(
    JOBS_TABLE_HEADERS,
    rows.map((row) => [row.jobId, row.phase, row.provider, row.age]),
  );
}

/**
 * Renders every live job across all projects, grouped so the current directory's
 * jobs lead, shared KB jobs follow, and any remaining projects appear as a
 * directory-keyed map. KB jobs are global (they run against the shared corpus),
 * so they list here regardless of which directory `coral jobs` runs from.
 */
export function renderJobsList(rows: JobsListItem[], filters: JobsListDisplayFilters = {}): string {
  if (rows.length === 0) {
    return `No jobs match ${describeJobsMatch(filters)}`;
  }

  const kbRows = rows.filter((row) => row.jobKind === 'kb');
  const projectRows = rows.filter((row) => row.jobKind !== 'kb');
  const currentRows = filters.cwd === undefined ? [] : projectRows.filter((row) => row.cwd === filters.cwd);
  const otherRows = projectRows.filter((row) => filters.cwd === undefined || row.cwd !== filters.cwd);

  const sections: string[] = [];

  if (currentRows.length > 0) {
    sections.push(joinLines([`Current project (${filters.cwd})`, jobsTable(currentRows)]));
  }

  if (kbRows.length > 0) {
    sections.push(joinLines(['KB jobs (shared corpus)', jobsTable(kbRows)]));
  }

  const otherByDir = new Map<string, JobsListItem[]>();
  for (const row of otherRows) {
    const group = otherByDir.get(row.cwd) ?? [];
    group.push(row);
    otherByDir.set(row.cwd, group);
  }
  if (otherByDir.size > 0) {
    const blocks: string[] = ['Other projects'];
    for (const [dir, dirRows] of [...otherByDir.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      blocks.push(joinLines([`  ${dir}`, jobsTable(dirRows)]));
    }
    sections.push(joinLines(blocks));
  }

  return sections.join('\n\n');
}
