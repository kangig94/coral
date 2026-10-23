import { formatRecoveryQuarantineCommand } from './backend.js';
import type { WaitExecutionSelection } from '../../jobs/wait/execution-selection.js';
import { waitCommandPrefix } from '../../coordinator/handoff-routing/wait-command.js';
import { formatResultAvailability } from './result-availability.js';
import type { CauseRef } from '../../causality/cause-ref.js';
import { describeTerminalOutcome } from '../../jobs/outcome.js';
import { assertNever } from '../../infra/error-format.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { AbortRefusalNextStep } from '../../jobs/contracts/abort-registry.js';
import type { JobOperatorRemedy } from '../../jobs/contracts/operator-remedy.js';
import type { JobDetailResponse, JobStatus, JobTerminal, JobsListResponse } from '../../jobs/records.js';
import type { AcceptedLaunchResponse } from '../../jobs/launch.js';
import type { JobSendOutcome } from '../../jobs/send.js';
import type { CliJobSendOutcome } from '../dispatch.js';
import { formatTable, joinLines } from './text.js';
import { formatUsageSegment } from './usage.js';

export type JobsListItem = {
  jobId: string;
  execution: string;
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
  mine?: boolean;
  unwaited?: boolean;
  /** The caller's own directory. Jobs whose work directory equals it are the primary group,
   * because that is the relation an ambient selector uses. */
  cwd?: string;
};

export type CauseRefDescriber = (ref: CauseRef) => string;

type WorkflowChildJob = JobsListResponse['jobs'][number];

const MAX_INLINE = 10_000;

/** Remediation must preserve the caller's input tokens rather than substitute resolved file or stdin content. */
export type JobSendOutputContext = Readonly<{
  inputTokens: readonly string[];
  detach?: boolean;
}>;

export type UnknownLaunchOutcome = Readonly<{ kind: 'launch-outcome-unknown' }>;

export function formatUnknownLaunchOutcome(_outcome: UnknownLaunchOutcome): string {
  return [
    'Launch outcome unknown — the job may already be running. Check the job list before taking another action.',
    formatJobsOperatorCommand({ kind: 'jobs-list' }),
  ].join('\n');
}

export function formatJobSendResult(
  jobId: string,
  result: CliJobSendOutcome,
  context?: JobSendOutputContext,
): { text: string; exitCode: number } {
  switch (result.state) {
    case 'launched':
      return {
        text: `${formatLaunchStatus(result.launch, result.launch.execution ?? result.execution)}\n${formatLaunchWaitHint(result.launch)}`,
        exitCode: 0,
      };
    case 'delivered':
      return {
        text: "Message delivered to the running turn. Whether the agent acts on it is the agent's decision.",
        exitCode: 0,
      };
    case 'refused':
      return {
        text: [
          `Message refused (${result.code}): ${result.reason.replace(/\r\n|[\r\n\u2028\u2029]/gu, '\n  ')}`,
          ...(result.priorDeliveryUncertain === true
            ? [
                'An earlier invocation may have delivered this message. This refusal does not resolve that uncertainty.',
                formatJobsOperatorCommand({
                  kind: 'wait-job',
                  jobId,
                  grammar: 'current',
                  executionSelection: result.executionSelection,
                }),
              ]
            : jobSendRefusalRemedy(jobId, result, context)),
        ].join('\n'),
        exitCode: 1,
      };
    case 'unknown':
      return {
        text: [
          "Unknown: message may have been delivered. Check the job's progress for evidence.",
          formatJobsOperatorCommand({
            kind: 'wait-job',
            jobId,
            grammar: 'current',
            ...(result.executionSelection === undefined ? {} : { executionSelection: result.executionSelection }),
          }),
          'Do not resend until the wait shows the outcome.',
        ].join('\n'),
        exitCode: 75,
      };
  }
}

type JobSendRefusalCode = Extract<JobSendOutcome, { state: 'refused' }>['code'];

type RemedyPolicy =
  | Readonly<{ kind: 'invalid-request' | 'retry' | 'terminal' | 'target-changed' | 'uncertain' }>
  | Readonly<{
      kind: 'inspect';
      message: string;
      command: 'wait-job' | 'jobs-detail' | 'jobs-list' | 'backend-status';
      all?: true;
    }>
  | Readonly<{ kind: 'unrestorable'; diagnosis: string }>
  | Readonly<{ kind: 'fresh-provider'; diagnosis: readonly string[] }>;

const jobSendRemedyPolicies = {
  invalid_request: { kind: 'invalid-request' },
  session_busy: { kind: 'uncertain' },
  execution_finishing: { kind: 'uncertain' },
  continuation_target_changed: { kind: 'target-changed' },
  execution_superseded: { kind: 'target-changed' },
  turn_not_started: { kind: 'retry' },
  control_unavailable: { kind: 'retry' },
  busy: { kind: 'retry' },
  succession_admission_paused: { kind: 'retry' },
  turn_ended: { kind: 'terminal' },
  job_not_running: { kind: 'inspect', message: "Read the job's result.", command: 'wait-job' },
  provider_rejected: { kind: 'inspect', message: "Read the job's result.", command: 'wait-job' },
  transport_unsupported: { kind: 'inspect', message: "Read the job's result.", command: 'wait-job' },
  not_found: {
    kind: 'inspect',
    message: 'List the available jobs, including ended jobs.',
    command: 'jobs-list',
    all: true,
  },
  scope_mismatch: {
    kind: 'inspect',
    message:
      "The job belongs to a work directory outside this cwd. Nothing was written. Run the printed list command from the current directory; it lists all projects, including terminal jobs. Take the job's work directory from its output, then rerun the send from that directory or a directory that contains it.",
    command: 'jobs-list',
    all: true,
  },
  non_provider_job: {
    kind: 'inspect',
    message: 'This job has no provider conversation. Read its detail to find the owning operation.',
    command: 'jobs-detail',
  },
  owner_not_provider_session: {
    kind: 'inspect',
    message:
      'The owning workflow, discussion or system task controls further executions. Read its ownership in job detail.',
    command: 'jobs-detail',
  },
  archive_missing: { kind: 'unrestorable', diagnosis: 'No retained conversation is available to continue.' },
  archive_hash_mismatch: {
    kind: 'unrestorable',
    diagnosis:
      'The archived conversation failed integrity verification; these bytes cannot be used for a continuation.',
  },
  archive_invalid: {
    kind: 'unrestorable',
    diagnosis: 'The archived conversation has invalid structure or identity and cannot be continued.',
  },
  profile_mismatch: {
    kind: 'fresh-provider',
    diagnosis: [
      'Continuation is impossible from this environment with its selected profile. If the original profile is known, select it through CODEX_HOME (Codex) or CLAUDE_CONFIG_DIR (Claude) in an environment that can access it.',
      'Alternatively, start a new conversation with a fresh provider job. This does not continue this conversation.',
    ],
  },
  work_directory_missing: {
    kind: 'inspect',
    message: 'Read the recorded work directory in job detail. Restore that directory before a new send attempt.',
    command: 'jobs-detail',
  },
  pre_generation_job: {
    kind: 'fresh-provider',
    diagnosis: ['This historical job is not continuable. Start a fresh provider job to continue the work.'],
  },
  native_unobservable: {
    kind: 'inspect',
    message: 'Read job detail before a new send attempt.',
    command: 'jobs-detail',
  },
  provider_preflight_failed: {
    kind: 'inspect',
    message: 'Read job detail before a new send attempt.',
    command: 'jobs-detail',
  },
  provider_preflight_undetermined: {
    kind: 'inspect',
    message: 'Read job detail before a new send attempt.',
    command: 'jobs-detail',
  },
  work_directory_unobservable: {
    kind: 'inspect',
    message: 'Read job detail before a new send attempt.',
    command: 'jobs-detail',
  },
  session_not_found: { kind: 'inspect', message: 'Read job detail before a new send attempt.', command: 'jobs-detail' },
  unsupported_by_running_build: {
    kind: 'inspect',
    message:
      'Inspect the pending upgrade and its next automatic action. A pending upgrade proceeds automatically when its recorded conditions clear. If none is pending, wait for the coordinator to retire idle, then the next CLI call starts the installed build. Idle retirement normally requires at least 6 hours without activity; each CLI reuse resets the timer. Retry the send after the installed build is serving.',
    command: 'backend-status',
  },
} satisfies Record<JobSendRefusalCode, RemedyPolicy>;

function jobSendRefusalRemedy(
  jobId: string,
  result: Extract<CliJobSendOutcome, { state: 'refused' }>,
  context: JobSendOutputContext | undefined,
): readonly string[] {
  const policy = jobSendRemedyPolicies[result.code];
  switch (policy.kind) {
    case 'invalid-request':
      return jobSendInvalidRequestRemedy(jobId, result, context);
    case 'uncertain':
      return jobSendUncertainRemedy(jobId, result.executionSelection);
    case 'target-changed':
      return jobSendTargetChangedRemedy(jobId, context);
    case 'retry':
      return jobSendRetryRemedy(jobId, context);
    case 'terminal':
      return jobSendTerminalRemedy(jobId, result.executionSelection, context);
    case 'inspect':
      return jobSendInspectionRemedy(jobId, policy, result.executionSelection);
    case 'unrestorable':
      return jobSendUnrestorableRemedy(jobId, policy.diagnosis, result.executionSelection, context);
    case 'fresh-provider':
      return [...policy.diagnosis, ...jobSendFreshProviderRemedy(context)];
    default:
      return assertNever(policy);
  }
}

function jobSendInvalidRequestRemedy(
  jobId: string,
  result: Extract<CliJobSendOutcome, { state: 'refused' }>,
  context: JobSendOutputContext | undefined,
): readonly string[] {
  return [
    'This invocation was rejected before delivery. Nothing was delivered.',
    ...(result.invalidFields?.length && result.invalidFields.every((field) => field === 'input')
      ? ['Re-run with a corrected -i: supply non-whitespace input of at most 65,536 UTF-16 code units.']
      : [
          'Make a new send attempt; it reads a fresh execution target and uses a new message ID.',
          ...jobSendStdinReminder(context),
          ...(context === undefined ? [] : [formatJobsOperatorCommand({ kind: 'send-job', jobId, ...context })]),
        ]),
  ];
}

function jobSendUncertainRemedy(
  jobId: string,
  executionSelection: WaitExecutionSelection | undefined,
): readonly string[] {
  return [
    'This invocation wrote nothing; an earlier invocation with this message identity may have delivered it.',
    formatJobsOperatorCommand({ kind: 'wait-job', jobId, grammar: 'current', executionSelection }),
    'Resend only if the result does not reflect the message. A new intentional send reads a fresh target and uses a new message ID.',
  ];
}

function jobSendTargetChangedRemedy(jobId: string, context: JobSendOutputContext | undefined): readonly string[] {
  return [
    'Read job detail before a new intentional send attempt.',
    formatJobsOperatorCommand({ kind: 'jobs-detail', jobId }),
    ...jobSendNewAttemptRemedy(jobId, context),
  ];
}

function jobSendInspectionRemedy(
  jobId: string,
  policy: Extract<RemedyPolicy, { kind: 'inspect' }>,
  executionSelection: WaitExecutionSelection | undefined,
): readonly string[] {
  return [
    policy.message,
    formatJobsOperatorCommand({ kind: policy.command, jobId, grammar: 'current', all: policy.all, executionSelection }),
  ];
}

function jobSendRetryRemedy(jobId: string, context: JobSendOutputContext | undefined): readonly string[] {
  return context === undefined
    ? ['Nothing was written. Try again with the same message.']
    : [
        'Nothing was written. Run the same request again.',
        ...jobSendStdinReminder(context),
        formatJobsOperatorCommand({ kind: 'send-job', jobId, ...context }),
      ];
}

function jobSendTerminalRemedy(
  jobId: string,
  executionSelection: WaitExecutionSelection | undefined,
  context: JobSendOutputContext | undefined,
): readonly string[] {
  return [
    "Read the job's result before requesting another execution of its conversation.",
    formatJobsOperatorCommand({ kind: 'wait-job', jobId, grammar: 'current', executionSelection }),
    ...jobSendNewAttemptRemedy(jobId, context),
  ];
}

function jobSendNewAttemptRemedy(jobId: string, context: JobSendOutputContext | undefined): readonly string[] {
  return context === undefined
    ? ['Make a new intentional send attempt with the same message supplied again; it reads a fresh execution target.']
    : [
        'A new intentional send attempt reads a fresh execution target and uses a new message ID.',
        ...jobSendStdinReminder(context),
        formatJobsOperatorCommand({ kind: 'send-job', jobId, ...context }),
      ];
}

function jobSendUnrestorableRemedy(
  jobId: string,
  diagnosis: string,
  executionSelection: WaitExecutionSelection | undefined,
  context: JobSendOutputContext | undefined,
): readonly string[] {
  return [
    diagnosis,
    'Read the execution result.',
    formatJobsOperatorCommand({ kind: 'wait-job', jobId, grammar: 'current', executionSelection }),
    'Start a new conversation with a fresh provider job. This does not continue this conversation.',
    ...jobSendFreshProviderRemedy(context),
  ];
}

function jobSendFreshProviderRemedy(context: JobSendOutputContext | undefined): readonly string[] {
  if (context === undefined) return [];
  return [
    ...jobSendStdinReminder(context),
    ...(['codex', 'claude'] as const).map((provider) =>
      formatJobsOperatorCommand({ kind: 'fresh-provider', provider, ...context }),
    ),
  ];
}

function jobSendStdinReminder(context: JobSendOutputContext | undefined): readonly string[] {
  return context?.inputTokens.join(' ') === '-'
    ? ['Coral does not retain stdin content. Pipe the same original input into the command you run.']
    : [];
}

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
  if (filters.mine === true) parts.push('--mine (launched by this session)');
  if (filters.unwaited === true) parts.push('--unwaited (no active wait or release)');

  return parts.join(', ');
}

export function formatLaunch(result: AcceptedLaunchResponse): string {
  const launchState = result.launchState === 'running' ? 'launch accepted' : result.launchState;
  const ordinal = result.execution === undefined ? '' : ` execution #${result.execution}`;
  return result.kind === 'provider-session'
    ? `Provider job ${result.jobId}${ordinal} ${launchState}`
    : `Workflow ${result.workflowId} ${launchState} (job ${result.jobId}${ordinal})`;
}

export function formatDetachedLaunchStatus(result: AcceptedLaunchResponse): string {
  return formatLaunchStatus(result, result.execution ?? 1);
}

function formatLaunchStatus(result: AcceptedLaunchResponse, execution: number | undefined): string {
  const ordinal = execution === undefined ? '' : ` execution #${execution}`;
  return result.kind === 'provider-session'
    ? `Provider job ${result.jobId}${ordinal} ${result.launchState}`
    : `Workflow ${result.workflowId} ${result.launchState} (job ${result.jobId}${ordinal})`;
}

export function formatLaunchWaitHint(
  result: Pick<AcceptedLaunchResponse, 'jobId' | 'requestedSeq' | 'epochKey'>,
): string {
  return [
    'Wait for completion with the command below.',
    formatJobsOperatorCommand({
      jobId: result.jobId,
      kind: 'wait-job',
      executionSelection: {
        jobId: result.jobId,
        epochKey: result.epochKey,
        requestedSeq: result.requestedSeq,
        awaitingArtifact: false,
      },
    }),
  ].join('\n');
}

export function formatAbortResult(result: AbortResult): string {
  const aborted = result.aborted.filter((jobId) => !result.stopRequested?.includes(jobId));
  return joinLines([
    aborted.length > 0
      ? `Aborted jobs: ${aborted.join(', ')}`
      : result.stopRequested?.length
        ? undefined
        : 'No jobs aborted',
    result.stopRequested !== undefined && result.stopRequested.length > 0
      ? `Stop requested for jobs: ${result.stopRequested.join(', ')}`
      : undefined,
    ...(result.stopDiagnostics ?? []).map(({ jobId, lastError }) => `Stop diagnostic for ${jobId}: ${lastError}`),
    result.notFound.length > 0 ? `Not found: ${result.notFound.join(', ')}` : undefined,
    ...(result.refused ?? []).flatMap((refusal) => [
      refusal.reason === 'job_pre_epoch_history'
        ? `Pre-epoch history may contain ${refusal.jobId}; this build cannot read it.`
        : `Abort held for ${refusal.jobId}: ${refusal.reason}`,
      ...formatAbortNextStep(refusal.nextStep),
    ]),
    ...(result.held ?? []).flatMap((hold) => [
      `Abort held for ${hold.jobId}: ${hold.reason}`,
      ...formatAbortNextStep(hold.nextStep),
    ]),
    ...(result.abandoned ?? []).flatMap((abandonment) => [
      `Job ownership abandoned for ${abandonment.jobId}: ${abandonment.reason}`,
      'Warning: Process absence remains unproven.',
      ...formatAbortNextStep(abandonment.nextStep),
    ]),
  ]);
}

export function formatWorkflowSlot(status: Pick<JobStatus, 'parentWorkflowJobId' | 'workflowSlotId'>): string | null {
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

export function formatJobsList(data: JobsListResponse, now = Date.now()): JobsListItem[] {
  return data.jobs.map(({ jobId, status, released }) => ({
    jobId,
    execution: status.execution === null ? '-' : `#${status.execution}`,
    phase: `${status.phase}${status.finishingStatus === undefined ? (status.finishing === true ? ' (finishing)' : '') : ` (finishing ${status.finishingStatus.kind}: ${status.finishingStatus.reason})`}${released === true ? ' (released)' : ''}`,
    provider: status.provider ?? status.jobKind,
    cwd: status.workDir ?? status.projectRoot,
    jobKind: status.jobKind,
    workflowSlot: formatWorkflowSlot(status) ?? JOBS_TABLE_NO_SLOT,
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

  const ordered = [...children].sort(
    (left, right) =>
      (formatWorkflowSlot(left.status) ?? '').localeCompare(formatWorkflowSlot(right.status) ?? '') ||
      (left.status.execution ?? 0) - (right.status.execution ?? 0) ||
      left.jobId.localeCompare(right.jobId),
  );

  return joinLines([
    'Workflow children:',
    formatTable(
      ['SLOT', 'EXECUTION', 'CHILD JOB ID'],
      ordered.map(({ jobId, status }) => [
        formatWorkflowSlot(status) ?? '-',
        status.execution?.toString() ?? '-',
        jobId,
      ]),
    ),
  ]);
}

export function formatJobDetail(
  response: JobDetailResponse,
  describeCauseRef?: CauseRefDescriber,
  workflowChildren: ReadonlyArray<WorkflowChildJob> = [],
  full = false,
): string {
  const status = response.status;
  const lines = [
    `Job ${status.jobId}`,
    `Phase: ${status.phase}`,
    status.execution === null ? undefined : `Latest execution: #${status.execution}`,
    status.finishing === true ? 'Finishing: true' : undefined,
    status.finishingStatus?.kind === 'blocked' && status.finishingStatus.successor === 'recovery-quarantine'
      ? formatRecoveryQuarantineCommand({ kind: 'list' })
      : undefined,
    status.finishingStatus === undefined
      ? undefined
      : `Finishing status: ${status.finishingStatus.kind}; ${status.finishingStatus.reason}; successor=${status.finishingStatus.successor}`,
    `Readiness: ${response.readiness}`,
    status.provider === null ? undefined : `Provider: ${status.provider}`,
    `Kind: ${status.jobKind}`,
    `Owner: ${status.owner.kind} ${status.owner.id}`,
    status.parentWorkflowJobId === undefined ? undefined : `Parent workflow: ${status.parentWorkflowJobId}`,
    status.workflowSlotId === undefined ? undefined : `Workflow slot: ${status.workflowSlotId}`,
    formatWorkflowChildren(workflowChildren),
    `Project: ${status.projectRoot}`,
    status.workDir === null ? undefined : `Work dir: ${status.workDir}`,
    `Updated: ${status.updatedAt}`,
    status.lastSeq === undefined ? undefined : `Last seq: ${status.lastSeq}`,
    response.executions === undefined && response.availability !== undefined
      ? formatResultAvailability(response.availability)
      : undefined,
    ...(response.executions === undefined
      ? [formatExecutionResult(response, describeCauseRef, full, response.epochKey)]
      : response.executions.map((execution) =>
          joinLines([
            `Execution #${execution.execution}`,
            `Phase: ${execution.status.phase}`,
            execution.status.finishing === true ? 'Finishing: true' : undefined,
            `Readiness: ${execution.readiness}`,
            `Requested seq: ${execution.requestedSeq}`,
            execution.exit === null
              ? undefined
              : joinLines([
                  execution.availability?.kind === 'available' ? undefined : `Result location: ${execution.resultPath}`,
                  execution.availability === undefined ? undefined : formatResultAvailability(execution.availability),
                ]),
            formatExecutionResult(execution, describeCauseRef, full, response.epochKey),
          ]),
        )),
  ];

  return joinLines(lines);
}

function formatExecutionResult(
  response: Pick<JobDetailResponse, 'status' | 'exit' | 'requestedSeq'>,
  describeCauseRef: CauseRefDescriber | undefined,
  full: boolean,
  epochKey: string | undefined,
): string {
  const exit = response.exit;
  if (exit === null) {
    return joinLines([
      'Follow it with the command below.',
      formatJobsOperatorCommand({
        kind: 'wait-job',
        jobId: response.status.jobId,
        ...(epochKey === undefined || response.requestedSeq === undefined
          ? {}
          : {
              executionSelection: {
                jobId: response.status.jobId,
                epochKey,
                requestedSeq: response.requestedSeq,
                awaitingArtifact: false,
              },
            }),
      }),
    ]);
  }
  const usage = formatUsageSegment(exit.diagnostics.usage, { verbose: true, cacheReadAnnotation: 'full' });
  return joinLines([
    `Exit: ${terminalOutcomeText(exit, describeCauseRef)}`,
    `Ended: ${exit.endTime}`,
    full ? `Diagnostics:\n${JSON.stringify(exit.diagnostics, null, 2)}` : undefined,
    usage === undefined ? undefined : `Usage:\n  ${usage}`,
    `Result:\n${full ? (exit.content.length > 0 ? exit.content : pickTerminalPreviewSource(exit, describeCauseRef)) : truncatePreview(pickTerminalPreviewSource(exit, describeCauseRef))}`,
  ]);
}

/** What `workflowSlot` carries when a job occupies no workflow slot, so the column can be dropped entirely. */
const JOBS_TABLE_NO_SLOT = '-';
const JOBS_TABLE_HEADERS = ['JOB ID', 'EXECUTION', 'PHASE', 'PROVIDER', 'AGE'];
const JOBS_TABLE_HEADERS_WITH_SLOT = ['JOB ID', 'SLOT', 'EXECUTION', 'PHASE', 'PROVIDER', 'AGE'];

/**
 * A workflow child's job id is a UUID that says nothing about which atom it ran, so the slot has to be
 * visible — but most jobs are not workflow children, and a column of dashes on every ordinary listing is a
 * cost paid by everyone to inform no one.
 */
function jobsTable(rows: JobsListItem[]): string {
  const hasSlot = rows.some((row) => row.workflowSlot !== JOBS_TABLE_NO_SLOT);
  return hasSlot
    ? formatTable(
        JOBS_TABLE_HEADERS_WITH_SLOT,
        rows.map((row) => [row.jobId, row.workflowSlot, row.execution, row.phase, row.provider, row.age]),
      )
    : formatTable(
        JOBS_TABLE_HEADERS,
        rows.map((row) => [row.jobId, row.execution, row.phase, row.provider, row.age]),
      );
}

/**
 * KB jobs are global (they run against the shared corpus), so they list here regardless of which directory
 * `coral jobs` runs from.
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
    sections.push(joinLines([`Current work directory (${filters.cwd})`, jobsTable(currentRows)]));
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
    const blocks: string[] = ['Other work directories'];
    for (const [dir, dirRows] of [...otherByDir.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      blocks.push(joinLines([`  ${dir}`, jobsTable(dirRows)]));
    }
    sections.push(joinLines(blocks));
  }

  return sections.join('\n\n');
}
export type JobsOperatorCommand =
  | Readonly<{ kind: 'backend-status' }>
  | Readonly<{ kind: 'jobs-detail-full'; jobId: string }>
  | JobOperatorRemedy
  | Readonly<{ kind: 'wait-job'; jobId: string; grammar?: 'current'; executionSelection?: WaitExecutionSelection }>
  | (Readonly<{ kind: 'send-job'; jobId: string }> & JobSendOutputContext)
  | Readonly<{ kind: 'jobs-list'; all?: boolean }>
  | (Readonly<{ kind: 'fresh-provider'; provider: 'codex' | 'claude' }> & JobSendOutputContext);

export function renderJobsOperatorCommand(command: JobsOperatorCommand): string {
  switch (command.kind) {
    case 'backend-status':
      return 'coral-cli backend status';
    case 'fresh-provider':
      return `coral-cli ${command.provider}${command.detach === true ? ' -d' : ''} ${renderJobsInputTokens(command.inputTokens)}`;
    case 'abort-job':
      return `coral-cli jobs abort ${command.jobId}`;
    case 'jobs-detail-full':
      return `coral-cli jobs detail ${command.jobId} --full`;
    case 'jobs-detail':
      return `coral-cli jobs detail ${command.jobId}`;
    case 'wait-job':
      return `${command.grammar === 'current' ? 'coral-cli jobs wait' : waitCommandPrefix()} ${quoteJobsCommandArgument(command.jobId)}${command.executionSelection === undefined ? '' : ` --execution-selection ${quoteJobsCommandArgument(JSON.stringify([command.executionSelection]))}`}`;
    case 'send-job':
      return `coral-cli jobs send ${quoteJobsCommandArgument(command.jobId)}${command.detach === true ? ' -d' : ''} ${renderJobsInputTokens(command.inputTokens)}`;
    case 'jobs-list':
      return `coral-cli jobs list${command.all === true ? ' --all' : ''}`;
  }
}

function renderJobsInputTokens(inputTokens: readonly string[]): string {
  if (inputTokens.length === 1 && inputTokens[0] === '-') return '-i -';
  return inputTokens.some((token) => token.startsWith('-'))
    ? inputTokens.map((token) => `--input=${quoteJobsCommandArgument(token)}`).join(' ')
    : `-i ${inputTokens.map(quoteJobsCommandArgument).join(' ')}`;
}

function quoteJobsCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (/[\r\n]/.test(value)) {
    return `$'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatJobsOperatorCommand(command: JobsOperatorCommand): string {
  return `command=${renderJobsOperatorCommand(command)}`;
}

function formatAbortNextStep(nextStep: AbortRefusalNextStep): readonly string[] {
  return typeof nextStep === 'string'
    ? [`Next step: ${nextStep}`]
    : [`Next step: ${nextStep.detail}`, formatJobsOperatorCommand(nextStep.remedy)];
}
