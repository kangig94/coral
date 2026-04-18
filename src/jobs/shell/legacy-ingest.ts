import type { AppendedEvent } from '../../store/append.js';
import type { CoralEventInput } from '../../store/index.js';
import type {
  LegacyCoralFault,
  LegacyTerminalOutcome,
} from '../../shared/legacy-terminal-outcome-compat.js';
import type { CauseRef, JobLifecycleFault, TerminalOutcome } from '../outcome.js';

export interface LegacyIngestOptions {
  readonly jobId: string;
  readonly sessionId: string;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowSlotId?: string;
}

export interface LegacyIngestPlan {
  readonly domainEvents: readonly CoralEventInput[];
  readonly immediateOutcome: Exclude<TerminalOutcome, { kind: 'failed' }> | null;
  readonly failedCauseEventIndex?: number;
}

function baseRefs(options: LegacyIngestOptions): NonNullable<CoralEventInput['refs']> {
  return {
    jobId: options.jobId,
    sessionId: options.sessionId,
    ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
  };
}

function baseEvent(
  options: LegacyIngestOptions,
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

function jobFaultFromLegacy(fault: Extract<LegacyCoralFault, { kind: 'ghost_launch' | 'wrapper_lost' | 'wrapper_crashed' }>): JobLifecycleFault {
  switch (fault.kind) {
    case 'ghost_launch':
      return { kind: 'ghost_launch' };
    case 'wrapper_lost':
      return { kind: 'wrapper_lost' };
    case 'wrapper_crashed':
      return { kind: 'wrapper_crashed', cause: fault.cause };
  }
}

function planFailed(
  options: LegacyIngestOptions,
  event: CoralEventInput,
): LegacyIngestPlan {
  return {
    domainEvents: [event],
    immediateOutcome: null,
    failedCauseEventIndex: 0,
  };
}

export function planLegacyTerminalOutcome(
  outcome: LegacyTerminalOutcome,
  options: LegacyIngestOptions,
): LegacyIngestPlan {
  switch (outcome.kind) {
    case 'completed':
      return { domainEvents: [], immediateOutcome: { kind: 'completed' } };
    case 'aborted':
      return { domainEvents: [], immediateOutcome: { kind: 'aborted', reason: outcome.reason } };
    case 'provider_exit':
      return { domainEvents: [], immediateOutcome: { kind: 'provider_exit', code: outcome.code, ...(outcome.note ? { note: outcome.note } : {}) } };
    case 'legacy_fault':
      switch (outcome.fault.kind) {
        case 'ghost_launch':
        case 'wrapper_lost':
        case 'wrapper_crashed':
          return {
            domainEvents: [],
            immediateOutcome: { kind: 'job_fault', fault: jobFaultFromLegacy(outcome.fault) },
          };
        case 'stale_status_schema':
        case 'recovery_parse_failed':
          return planFailed(
            options,
            baseEvent(options, { kind: 'job', id: options.jobId }, 'job.progress.emitted', outcome.fault),
          );
        case 'launch_rejected':
          return planFailed(
            options,
            baseEvent(options, { kind: 'job', id: options.jobId }, 'job.launch.rejected', outcome.fault),
          );
        case 'app_server_interrupted':
          return planFailed(
            options,
            baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.interrupted', outcome.fault),
          );
        case 'adapter_output_unparseable':
          return planFailed(
            options,
            baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.adapter_unparseable', {
              provider: outcome.fault.provider,
              stdout: outcome.fault.stdout,
              stderr: outcome.fault.stderr,
              parseError: outcome.fault.parseError,
            }),
          );
        case 'provider_session_unavailable':
          return planFailed(
            options,
            baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.provider_failed', {
              provider: outcome.fault.provider,
              reason: 'session_unavailable',
              message: outcome.fault.note,
            }),
          );
        case 'provider_request_failed':
          return planFailed(
            options,
            baseEvent(options, { kind: 'session', id: options.sessionId }, 'session.provider_failed', {
              provider: outcome.fault.provider,
              reason: 'request_failed',
              message: outcome.fault.message,
            }),
          );
        case 'workflow_atom_failed':
        case 'workflow_aborted':
          throw new Error(
            `Legacy workflow fault '${outcome.fault.kind}' must be bridged at the workflow boundary, not jobs/shell/legacy-ingest.ts`,
          );
      }
  }
}

export function materializeLegacyTerminalOutcome(
  plan: LegacyIngestPlan,
  appendedEvents: readonly Pick<AppendedEvent, 'seq' | 'stream'>[],
): TerminalOutcome {
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  const index = plan.failedCauseEventIndex;
  if (index === undefined) {
    throw new Error('Legacy ingest plan is missing failedCauseEventIndex.');
  }

  const event = appendedEvents[index];
  if (!event) {
    throw new Error('Legacy ingest outcome requires an appended cause event.');
  }

  return {
    kind: 'failed',
    causeRef: {
      stream: event.stream as CauseRef['stream'],
      seq: event.seq,
    },
  };
}

export function immediateLegacyTerminalOutcome(outcome: LegacyTerminalOutcome): TerminalOutcome | null {
  return planLegacyTerminalOutcome(outcome, {
    jobId: 'legacy-ingest',
    sessionId: 'legacy-ingest',
  }).immediateOutcome;
}
