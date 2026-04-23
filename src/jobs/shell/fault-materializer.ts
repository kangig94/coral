import type { AppendedEvent } from '../../store/append.js';
import type { CoralEventInput } from '../../store/index.js';
import {
  ADAPTER_OUTPUT_UNPARSEABLE_KIND,
  PROVIDER_REQUEST_FAILED_KIND,
  PROVIDER_SESSION_UNAVAILABLE_KIND,
  type FaultPayload,
} from '../../providers/fault.js';
import type {
  CauseRef,
  JobLifecycleFault,
  JobLaunchRejected,
  JobProgressFault,
  TerminalOutcome,
} from '../outcome.js';
import type {
  SessionAdapterUnparseableFault,
  SessionInterruptedFault,
  SessionProviderFailedFault,
} from '../../sessions/fault.js';

export interface RuntimeIngestOptions {
  readonly jobId: string;
  readonly sessionId: string;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowSlotId?: string;
}

interface RuntimeIngestPlan {
  readonly domainEvents: readonly CoralEventInput[];
  readonly immediateOutcome: Exclude<TerminalOutcome, { kind: 'failed' }> | null;
  readonly failedCauseEventIndex?: number;
}

type JobRecoveryFault = JobLifecycleFault | JobProgressFault;
type AppendResultRow = Pick<AppendedEvent, 'seq' | 'stream'>;
type RuntimeAppendStore = Pick<
  { appendEventsWithResult(events: readonly CoralEventInput[]): readonly AppendResultRow[] },
  'appendEventsWithResult'
>;

function baseRefs(options: RuntimeIngestOptions): NonNullable<CoralEventInput['refs']> {
  return {
    jobId: options.jobId,
    sessionId: options.sessionId,
    ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
  };
}

function baseEvent(
  options: RuntimeIngestOptions,
  stream: CoralEventInput['stream'],
  type: string,
  body: unknown,
): CoralEventInput {
  return {
    type,
    stream,
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: baseRefs(options),
    bodyVersion: 1,
    body,
  };
}

function planFailed(
  options: RuntimeIngestOptions,
  event: CoralEventInput,
): RuntimeIngestPlan {
  return {
    domainEvents: [event],
    immediateOutcome: null,
    failedCauseEventIndex: 0,
  };
}

function materializePlannedOutcome(
  plan: RuntimeIngestPlan,
  appendedEvents: readonly Pick<AppendedEvent, 'seq' | 'stream'>[],
): TerminalOutcome {
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  const index = plan.failedCauseEventIndex;
  if (index === undefined) {
    throw new Error('Runtime ingest plan is missing failedCauseEventIndex.');
  }

  const event = appendedEvents[index];
  if (!event) {
    throw new Error('Runtime ingest outcome requires an appended cause event.');
  }

  return {
    kind: 'failed',
    causeRef: {
      stream: event.stream as CauseRef['stream'],
      seq: event.seq,
    },
  };
}

function appendFailedEvent(
  progressStore: RuntimeAppendStore,
  event: CoralEventInput,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  const plan = planFailed(options, event);
  const appended = progressStore.appendEventsWithResult(plan.domainEvents);
  return materializePlannedOutcome(plan, appended);
}

function planJobRecoveryFault(
  fault: JobRecoveryFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  switch (fault.kind) {
    case 'ghost_launch':
    case 'wrapper_lost':
    case 'wrapper_crashed':
      return {
        domainEvents: [],
        immediateOutcome: { kind: 'job_fault', fault },
      };
    case 'stale_status_schema':
    case 'recovery_parse_failed':
      return planFailed(
        options,
        baseEvent(options, { kind: 'job', id: options.jobId }, 'job.progress.emitted', fault),
      );
  }
}

export function jobRecoveryNeedsDomainEvent(fault: JobRecoveryFault): boolean {
  return fault.kind === 'stale_status_schema' || fault.kind === 'recovery_parse_failed';
}

export function materializeJobRecoveryFault(
  progressStore: RuntimeAppendStore,
  fault: JobRecoveryFault,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  const plan = planJobRecoveryFault(fault, options);
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  const appended = progressStore.appendEventsWithResult(plan.domainEvents);
  return materializePlannedOutcome(plan, appended);
}

export function materializeJobLaunchRejected(
  progressStore: RuntimeAppendStore,
  rejected: JobLaunchRejected,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  return appendFailedEvent(
    progressStore,
    baseEvent(options, { kind: 'job', id: options.jobId }, 'job.launch.rejected', rejected),
    options,
  );
}

export function materializeSessionInterrupted(
  progressStore: RuntimeAppendStore,
  fault: SessionInterruptedFault,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  return appendFailedEvent(
    progressStore,
    baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.interrupted', fault),
    options,
  );
}

export function materializeSessionProviderFailed(
  progressStore: RuntimeAppendStore,
  fault: SessionProviderFailedFault,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  return appendFailedEvent(
    progressStore,
    baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.provider_failed', fault),
    options,
  );
}

export function materializeSessionAdapterUnparseable(
  progressStore: RuntimeAppendStore,
  fault: SessionAdapterUnparseableFault,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  return appendFailedEvent(
    progressStore,
    baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.adapter_unparseable', fault),
    options,
  );
}

export function materializeProviderFault(
  progressStore: RuntimeAppendStore,
  fault: FaultPayload,
  options: RuntimeIngestOptions,
): TerminalOutcome {
  switch (fault.kind) {
    case ADAPTER_OUTPUT_UNPARSEABLE_KIND:
      return materializeSessionAdapterUnparseable(
        progressStore,
        {
          provider: fault.provider,
          exitCode: fault.exitCode,
          stdout: fault.stdout,
          stderr: fault.stderr,
          parseError: fault.parseError,
        },
        options,
      );
    case PROVIDER_SESSION_UNAVAILABLE_KIND:
      return materializeSessionProviderFailed(
        progressStore,
        {
          provider: fault.provider,
          reason: 'session_unavailable',
          message: fault.reason,
        },
        options,
      );
    case PROVIDER_REQUEST_FAILED_KIND:
      return materializeSessionProviderFailed(
        progressStore,
        {
          provider: fault.provider,
          reason: 'request_failed',
          message: fault.message,
        },
        options,
      );
  }
}
