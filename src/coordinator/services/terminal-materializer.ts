import type { CommitContext } from '../../store/append.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { ProviderTerminalEventBody } from '../../providers/contract.js';
import type { ProviderFailureCause } from '../../providers/fault.js';
import type { JobLifecycleFault, JobProgressFault, TerminalOutcome, TerminalOutcomeInput } from '../../jobs/outcome.js';
import type { JobTerminalDiagnostics, JobTerminalInput } from '../../jobs/records.js';
import type { JobContinuitySnapshot } from '../../jobs/continuity.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import {
  appendJobTerminalRecorded,
  failedTerminalOutcome,
  type JobTerminalRecordedOptions,
} from '../../jobs/terminal/recording.js';
import type {
  SessionAdapterUnparseableFault,
  SessionInterruptedFault,
  SessionProviderFailedFault,
} from '../../sessions/fault.js';
import {
  sessionAdapterUnparseableEvent,
  sessionInterruptedEvent,
  sessionProviderFailedEvent,
} from '../../sessions/event-builders.js';

export interface RuntimeIngestOptions {
  readonly jobId: string;
  readonly sessionId?: string | null;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowId?: string;
  readonly workflowSlotId?: string;
}

type RuntimeIngestDomainBody =
  | JobProgressFault
  | SessionInterruptedFault
  | SessionProviderFailedFault
  | SessionAdapterUnparseableFault;

export type RuntimeIngestPlan =
  | {
      readonly kind: 'immediate';
      readonly domainEvents: readonly [];
      readonly immediateOutcome: Exclude<TerminalOutcome, { kind: 'failed' }>;
    }
  | {
      readonly kind: 'failed_cause';
      readonly domainEvents: readonly [CoralEventInput<RuntimeIngestDomainBody>];
      readonly immediateOutcome: null;
    };

export type MaterializedProviderTerminal<Scope = never> = {
  terminal: JobTerminalInput<Scope>;
  diagnostics: JobTerminalDiagnostics;
};

export type MaterializedProviderTerminalRecipe = {
  terminal: Omit<JobTerminalInput, 'outcome'>;
  outcomePlan: RuntimeIngestPlan;
  diagnostics: JobTerminalDiagnostics;
};

type JobRecoveryFault = JobLifecycleFault | JobProgressFault;
type RuntimeCommitStore = Pick<JobProgressStore, 'commit'>;

export function baseRefs(options: RuntimeIngestOptions): NonNullable<CoralEventInput['refs']> {
  return {
    jobId: options.jobId,
    ...(options.sessionId === undefined || options.sessionId === null ? {} : { sessionId: options.sessionId }),
    ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
  };
}

function requireSessionId(options: RuntimeIngestOptions, eventType: string): string {
  if (options.sessionId === undefined || options.sessionId === null) {
    throw new Error(`${eventType} requires a provider session id.`);
  }
  return options.sessionId;
}

export function baseEvent(
  options: RuntimeIngestOptions,
  stream: CoralEventInput['stream'],
  type: string,
  body: RuntimeIngestDomainBody,
): CoralEventInput<RuntimeIngestDomainBody> {
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

function planFailed(event: CoralEventInput<RuntimeIngestDomainBody>): RuntimeIngestPlan {
  return {
    kind: 'failed_cause',
    domainEvents: [event],
    immediateOutcome: null,
  };
}

function planJobRecoveryFault(fault: JobRecoveryFault, options: RuntimeIngestOptions): RuntimeIngestPlan {
  switch (fault.kind) {
    case 'ghost_launch':
    case 'wrapper_lost':
    case 'wrapper_crashed':
      return {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome: { kind: 'job_fault', fault },
      };
    case 'missing_launch_record':
    case 'recovery_parse_failed':
      return planFailed(baseEvent(options, { kind: 'job', id: options.jobId }, 'job.progress.emitted', fault));
  }
}

function planSessionInterrupted(fault: SessionInterruptedFault, options: RuntimeIngestOptions): RuntimeIngestPlan {
  const sessionId = requireSessionId(options, 'session.interrupted');
  return planFailed(sessionInterruptedEvent(fault, { ...options, sessionId }));
}

function planSessionProviderFailed(
  fault: SessionProviderFailedFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  const sessionId = requireSessionId(options, 'session.provider_failed');
  const body: SessionProviderFailedFault = {
    provider: fault.provider,
    reason: fault.reason,
    message: fault.message,
    ...(fault.diagnostic === undefined ? {} : { diagnostic: fault.diagnostic }),
  };
  return planFailed(sessionProviderFailedEvent(body, { ...options, sessionId }));
}

function planSessionAdapterUnparseable(
  fault: SessionAdapterUnparseableFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  const sessionId = requireSessionId(options, 'session.adapter_unparseable');
  return planFailed(sessionAdapterUnparseableEvent(fault, { ...options, sessionId }));
}

function planProviderFailureCause(failure: ProviderFailureCause, options: RuntimeIngestOptions): RuntimeIngestPlan {
  switch (failure.type) {
    case 'session.adapter_unparseable':
      return planSessionAdapterUnparseable(failure.body, options);
    case 'session.provider_failed':
      return planSessionProviderFailed(failure.body, options);
  }
}

function planProviderOutcome(terminal: ProviderTerminalEventBody, options: RuntimeIngestOptions): RuntimeIngestPlan {
  const { outcome } = terminal.terminal;
  switch (outcome.kind) {
    case 'completed':
      return {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome: { kind: 'completed' },
      };
    case 'aborted':
      return {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome: { kind: 'aborted', reason: outcome.reason },
      };
    case 'provider_exit':
      return {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome:
          outcome.note === undefined
            ? { kind: 'provider_exit', code: outcome.code }
            : { kind: 'provider_exit', code: outcome.code, note: outcome.note },
      };
    case 'failed':
      if (terminal.failureCause === undefined) {
        throw new Error('Provider terminal failed without a canonical failureCause.');
      }
      return planProviderFailureCause(terminal.failureCause, options);
    case 'job_fault':
      // compose() synthesized a wrapper_lost terminal because the provider
      // stream closed without one (§8.3 #1). Materialize it as the same
      // job_fault outcome on the journal terminal.
      return planJobRecoveryFault(outcome.fault, options);
  }
}

function materializePlannedOutcomeInCommit<Scope>(
  c: CommitContext<Scope>,
  plan: RuntimeIngestPlan,
): TerminalOutcomeInput<Scope> {
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  const [causeEvent] = plan.domainEvents;
  if (causeEvent === undefined) {
    throw new Error('Runtime ingest plan is missing its failed cause event.');
  }

  return failedTerminalOutcome(c.append(causeEvent));
}

export function materializeJobRecoveryFaultInCommit<Scope>(
  c: CommitContext<Scope>,
  fault: JobRecoveryFault,
  options: RuntimeIngestOptions,
): TerminalOutcomeInput<Scope> {
  return materializePlannedOutcomeInCommit(c, planJobRecoveryFault(fault, options));
}

export function materializeProviderFailureCauseInCommit<Scope>(
  c: CommitContext<Scope>,
  failure: ProviderFailureCause,
  options: RuntimeIngestOptions,
): TerminalOutcomeInput<Scope> {
  return materializePlannedOutcomeInCommit(c, planProviderFailureCause(failure, options));
}

export function materializeProviderTerminal(
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): MaterializedProviderTerminalRecipe {
  const warnings = [...(terminal.terminal.warnings ?? []), ...(terminal.diagnostics.warnings ?? [])];
  return {
    terminal: {
      content: terminal.terminal.content,
      ...(terminal.terminal.durationMs === undefined ? {} : { durationMs: terminal.terminal.durationMs }),
    },
    outcomePlan: planProviderOutcome(terminal, options),
    diagnostics: {
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(terminal.terminal.usage === undefined ? {} : { usage: terminal.terminal.usage }),
      ...(terminal.terminal.exitCode === undefined
        ? {}
        : { processExit: { exitCode: terminal.terminal.exitCode, signal: null } }),
      ...(terminal.diagnostics.byteCounts === undefined ? {} : { byteCounts: { ...terminal.diagnostics.byteCounts } }),
    },
  };
}

export function materializeProviderTerminalInCommit<Scope>(
  c: CommitContext<Scope>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): MaterializedProviderTerminal<Scope> {
  const recipe = materializeProviderTerminal(terminal, options);
  return {
    terminal: {
      ...recipe.terminal,
      outcome: materializePlannedOutcomeInCommit(c, recipe.outcomePlan),
    },
    diagnostics: recipe.diagnostics,
  };
}

function terminalRecordOptions<Scope>(
  options: RuntimeIngestOptions,
  terminal: JobTerminalInput<Scope>,
  record: {
    readonly diagnostics?: JobTerminalDiagnostics;
    readonly continuity?: JobContinuitySnapshot | null;
  },
): JobTerminalRecordedOptions<Scope> {
  return {
    jobId: options.jobId,
    sessionId: options.sessionId ?? null,
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    parentJobId: options.parentJobId,
    workflowId: options.workflowId,
    workflowSlotId: options.workflowSlotId,
    terminal,
    diagnostics: record.diagnostics,
    continuity: record.continuity ?? null,
  };
}

export function recordProviderTerminalInCommit<Scope>(
  c: CommitContext<Scope>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
  record: {
    readonly continuity?: JobContinuitySnapshot | null;
  } = {},
): void {
  const materialized = materializeProviderTerminalInCommit(c, terminal, options);
  appendJobTerminalRecorded(
    c,
    terminalRecordOptions(options, materialized.terminal, {
      diagnostics: materialized.diagnostics,
      continuity: record.continuity ?? null,
    }),
  );
}

export function recordProviderTerminal(
  progressStore: RuntimeCommitStore,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
  record: {
    readonly continuity?: JobContinuitySnapshot | null;
  } = {},
): void {
  progressStore.commit((c) => {
    recordProviderTerminalInCommit(c, terminal, options, record);
    return undefined;
  });
}

function recordTerminalWithOutcomePlan(
  progressStore: RuntimeCommitStore,
  plan: RuntimeIngestPlan,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs?: number;
    readonly diagnostics?: JobTerminalDiagnostics;
    readonly continuity?: JobContinuitySnapshot | null;
  },
): void {
  progressStore.commit((c) => {
    const outcome = materializePlannedOutcomeInCommit(c, plan);
    appendJobTerminalRecorded(
      c,
      terminalRecordOptions(
        options,
        {
          content: record.content,
          ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
          outcome,
        },
        {
          diagnostics: record.diagnostics,
          continuity: record.continuity ?? null,
        },
      ),
    );
    return undefined;
  });
}

export function recordSessionInterruptedTerminal(
  progressStore: RuntimeCommitStore,
  fault: SessionInterruptedFault,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs?: number;
    readonly diagnostics?: JobTerminalDiagnostics;
    readonly continuity?: JobContinuitySnapshot | null;
  },
): void {
  recordTerminalWithOutcomePlan(progressStore, planSessionInterrupted(fault, options), options, record);
}

export function recordJobRecoveryFaultTerminal(
  progressStore: RuntimeCommitStore,
  fault: JobRecoveryFault,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs?: number;
    readonly diagnostics?: JobTerminalDiagnostics;
    readonly continuity?: JobContinuitySnapshot | null;
  },
): void {
  recordTerminalWithOutcomePlan(progressStore, planJobRecoveryFault(fault, options), options, record);
}
