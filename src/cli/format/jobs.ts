import type { CauseRef } from '../../causality/cause-ref.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import { assertNever } from '../../infra/error-format.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { JobDetailResponse, JobStatus, JobTerminal, JobsListResponse } from '../../jobs/records.js';
import type { AcceptedLaunchResponse } from '../../jobs/launch.js';
import { compareWorkflowSlotIds } from '../../infra/identifiers.js';
import { formatTable, joinLines } from './text.js';
import { formatUsageSegment } from './usage.js';

export type JobsListItem = {
  jobId: string;
  phase: string;
  provider: string;
  cwd: string;
  jobKind: string;
  workflowSlot: string;
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

type WorkflowChildJob = JobsListResponse['jobs'][number];

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
  const launchState = result.launchState === 'running' ? 'launch accepted' : result.launchState;
  return result.kind === 'provider-session'
    ? `Provider job ${result.jobId} ${launchState} (provider session ${result.sessionId})`
    : `Workflow ${result.workflowId} ${launchState} (job ${result.jobId})`;
}

export function formatDetachedLaunchStatus(result: AcceptedLaunchResponse): string {
  return result.kind === 'provider-session'
    ? `Provider job ${result.launchState} (provider session ${result.sessionId})`
    : `Workflow ${result.workflowId} ${result.launchState} (job ${result.jobId})`;
}

export function formatLaunchWaitHint(result: Pick<AcceptedLaunchResponse, 'jobId'>): string {
  return `Run coral-cli wait jobs ${result.jobId} to wait for completion.`;
}

export function formatAbortResult(result: AbortResult): string {
  return joinLines([
    result.aborted.length > 0 ? `Aborted jobs: ${result.aborted.join(', ')}` : 'No jobs aborted',
    result.notFound.length > 0 ? `Not found: ${result.notFound.join(', ')}` : undefined,
  ]);
}

function formatWorkflowSlotId(
  status: Pick<JobStatus, 'parentWorkflowJobId' | 'workflowSlotId' | 'workflowSlotGeneration'>,
): string | null {
  if (status.workflowSlotId === undefined) {
    return null;
  }

  const parentPrefix = status.parentWorkflowJobId === undefined ? null : `${status.parentWorkflowJobId}:`;
  const slot =
    parentPrefix !== null && status.workflowSlotId.startsWith(parentPrefix)
      ? status.workflowSlotId.slice(parentPrefix.length)
      : status.workflowSlotId;
  return slot;
}

export function formatWorkflowSlot(
  status: Pick<JobStatus, 'parentWorkflowJobId' | 'workflowSlotId' | 'workflowSlotGeneration'>,
): string | null {
  const slot = formatWorkflowSlotId(status);
  if (slot === null) {
    return null;
  }

  return status.workflowSlotGeneration === undefined ? slot : `${slot} (g${status.workflowSlotGeneration})`;
}

export function formatWorkflowChildIdentity(
  status: Pick<JobStatus, 'parentWorkflowJobId' | 'workflowSlotId' | 'workflowSlotGeneration' | 'workflowLabel'>,
): string | null {
  const slot = formatWorkflowSlot(status);
  if (slot === null) {
    return null;
  }
  return status.workflowLabel === undefined ? `slot ${slot}` : `${status.workflowLabel} · slot ${slot}`;
}

export function formatJobsList(data: JobsListResponse, now = Date.now()): JobsListItem[] {
  return data.jobs.map(({ jobId, status }) => ({
    jobId,
    phase: status.phase,
    provider: status.provider ?? status.jobKind,
    cwd: status.projectRoot,
    jobKind: status.jobKind,
    workflowSlot: formatWorkflowChildIdentity(status) ?? JOBS_TABLE_NO_SLOT,
    age: formatRelativeAge(status.updatedAt, now),
  }));
}

function terminalOutcomeText(result: JobTerminal, describeCauseRef?: CauseRefDescriber): string {
  switch (result.outcome.kind) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return `aborted: ${result.outcome.reason}`;
    case 'provider_exit': {
      const base = `provider exited ${result.outcome.code}`;
      return result.outcome.note === undefined ? base : `${base}: ${result.outcome.note}`;
    }
    case 'failed':
    case 'job_fault':
      return describeTerminalOutcome(result.outcome, { describeCauseRef });
    default:
      return assertNever(result.outcome);
  }
}

function formatWorkflowChildren(children: ReadonlyArray<WorkflowChildJob>): string | undefined {
  if (children.length === 0) {
    return undefined;
  }

  const ordered = [...children].sort((left, right) => {
    return (
      compareWorkflowSlotIds(left.status.workflowSlotId ?? '', right.status.workflowSlotId ?? '') ||
      (left.status.workflowSlotGeneration ?? 0) - (right.status.workflowSlotGeneration ?? 0) ||
      left.jobId.localeCompare(right.jobId)
    );
  });

  return joinLines([
    'Workflow children:',
    formatTable(
      ['SLOT', 'ATOM', 'GEN', 'CHILD JOB ID', 'REPLACES'],
      ordered.map(({ jobId, status }) => [
        formatWorkflowSlotId(status) ?? '-',
        status.workflowLabel ?? '-',
        status.workflowSlotGeneration?.toString() ?? '-',
        jobId,
        status.replacesWorkflowJobId ?? '-',
      ]),
    ),
  ]);
}

export function formatJobDetail(response: JobDetailResponse, describeCauseRef?: CauseRefDescriber): string {
  const status = response.status;
  const usage = formatUsageSegment(response.exit?.diagnostics.usage, {
    verbose: true,
    cacheReadAnnotation: 'full',
  });

  const lines = [
    `Job ${status.jobId}`,
    `Phase: ${status.phase}`,
    `Readiness: ${response.readiness}`,
    status.provider === null ? undefined : `Provider: ${status.provider}`,
    `Kind: ${status.jobKind}`,
    `Owner: ${status.owner.kind} ${status.owner.id}`,
    status.parentWorkflowJobId === undefined ? undefined : `Parent workflow: ${status.parentWorkflowJobId}`,
    status.workflowSlotId === undefined ? undefined : `Workflow slot: ${status.workflowSlotId}`,
    status.workflowSlotGeneration === undefined ? undefined : `Workflow generation: ${status.workflowSlotGeneration}`,
    status.workflowLabel === undefined ? undefined : `Workflow atom: ${status.workflowLabel}`,
    status.replacesWorkflowJobId === undefined ? undefined : `Replaces workflow job: ${status.replacesWorkflowJobId}`,
    formatWorkflowChildren(response.workflowChildren ?? []),
    status.sessionId === null ? undefined : `Provider session: ${status.sessionId}`,
    `Project: ${status.projectRoot}`,
    `Updated: ${status.updatedAt}`,
    status.lastSeq === undefined ? undefined : `Last seq: ${status.lastSeq}`,
    response.exit === null ? undefined : `Exit: ${terminalOutcomeText(response.exit, describeCauseRef)}`,
    response.exit?.endTime === undefined ? undefined : `Ended: ${response.exit.endTime}`,
    usage === undefined ? undefined : `Usage:\n  ${usage}`,
    response.exit === null
      ? `Run coral-cli wait jobs ${status.jobId} to follow it.`
      : `Result:\n${truncatePreview(pickTerminalPreviewSource(response.exit, describeCauseRef))}`,
  ];

  return joinLines(lines);
}

/** What `workflowSlot` carries when a job occupies no workflow slot, so the column can be dropped entirely. */
const JOBS_TABLE_NO_SLOT = '-';
const JOBS_TABLE_HEADERS = ['JOB ID', 'PHASE', 'PROVIDER', 'AGE'];
const JOBS_TABLE_HEADERS_WITH_SLOT = ['JOB ID', 'SLOT', 'PHASE', 'PROVIDER', 'AGE'];

/**
 * The slot column appears only when some row actually occupies a slot. A workflow child's job id is a UUID
 * that says nothing about which atom it ran, so the slot has to be visible — but most jobs are not workflow
 * children, and a column of dashes on every ordinary listing is a cost paid by everyone to inform no one.
 */
function jobsTable(rows: JobsListItem[]): string {
  const hasSlot = rows.some((row) => row.workflowSlot !== JOBS_TABLE_NO_SLOT);
  return hasSlot
    ? formatTable(
        JOBS_TABLE_HEADERS_WITH_SLOT,
        rows.map((row) => [row.jobId, row.workflowSlot, row.phase, row.provider, row.age]),
      )
    : formatTable(
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
