import type { CommitContext } from '../../store/append.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { ProviderTerminalEventBody } from '../../providers/contract.js';
import type { ProviderFailureCause } from '../../providers/fault.js';
import type { JobLifecycleFault, JobProgressFault, TerminalOutcome, TerminalOutcomeInput } from '../../jobs/outcome.js';
import type { JobTerminalDiagnostics, JobTerminalInput } from '../../jobs/records.js';
import {
  appendJobExecutionOutcomeAccepted,
  failedTerminalOutcome,
  type JobExecutionOutcomeAcceptedOptions,
} from '../../jobs/terminal/recording.js';
import type {
  SessionAdapterUnparseableFault,
  ConversationInterruptedFault,
  SessionProviderFailedFault,
} from '../../jobs/conversation/fault.js';

export interface RuntimeIngestOptions {
  readonly jobId: string;
  readonly execution: number;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowId?: string;
  readonly workflowSlotId?: string;
}

type RuntimeIngestDomainBody =
  | JobProgressFault
  | ConversationInterruptedFault
  | SessionProviderFailedFault
  | SessionAdapterUnparseableFault;

type RuntimeIngestPlan =
  | {
      readonly kind: 'immediate';
      readonly domainEvents: readonly [];
      readonly immediateOutcome: Exclude<TerminalOutcome, { kind: 'failed' }>;
    }
  | {
      readonly kind: 'failed_cause';
      readonly domainEvents: readonly [CoralEventInput<RuntimeIngestDomainBody & { execution: number }>];
      readonly immediateOutcome: null;
    };

type MaterializedProviderTerminal<Scope = never> = {
  terminal: JobTerminalInput<Scope>;
  diagnostics: JobTerminalDiagnostics;
};

export type MaterializedProviderTerminalRecipe = {
  terminal: Omit<JobTerminalInput, 'outcome'>;
  outcomePlan: RuntimeIngestPlan;
  diagnostics: JobTerminalDiagnostics;
};

type JobRecoveryFault = JobLifecycleFault | JobProgressFault;

function baseRefs(options: RuntimeIngestOptions): NonNullable<CoralEventInput['refs']> {
  return {
    jobId: options.jobId,
    ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    ...(options.workflowSlotId ? { workflowSlotId: options.workflowSlotId } : {}),
  };
}

function baseEvent(
  options: RuntimeIngestOptions,
  stream: CoralEventInput['stream'],
  type: string,
  body: RuntimeIngestDomainBody,
): CoralEventInput<RuntimeIngestDomainBody & { execution: number }> {
  return {
    type,
    stream,
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: baseRefs(options),
    body: { ...body, execution: options.execution },
  };
}

function planFailed(event: CoralEventInput<RuntimeIngestDomainBody & { execution: number }>): RuntimeIngestPlan {
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
    case 'provider_binding':
      return {
        kind: 'immediate',
        domainEvents: [],
        immediateOutcome: { kind: 'job_fault', fault },
      };
    case 'missing_launch_record':
    case 'recovery_parse_failed':
      return planFailed(baseEvent(options, { kind: 'job', id: options.jobId }, 'job.execution.progress', fault));
  }
}

function planConversationInterrupted(
  fault: ConversationInterruptedFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  return planFailed(baseEvent(options, { kind: 'job', id: options.jobId }, 'job.interrupted', fault));
}

function planSessionProviderFailed(
  fault: SessionProviderFailedFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  const body: SessionProviderFailedFault = {
    provider: fault.provider,
    reason: fault.reason,
    message: fault.message,
    ...(fault.diagnostic === undefined ? {} : { diagnostic: fault.diagnostic }),
  };
  return planFailed(baseEvent(options, { kind: 'job', id: options.jobId }, 'job.provider_failed', body));
}

function planSessionAdapterUnparseable(
  fault: SessionAdapterUnparseableFault,
  options: RuntimeIngestOptions,
): RuntimeIngestPlan {
  return planFailed(baseEvent(options, { kind: 'job', id: options.jobId }, 'job.adapter_unparseable', fault));
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
      durationMs: terminal.terminal.durationMs,
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

function materializeProviderTerminalInCommit<Scope>(
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
  },
): JobExecutionOutcomeAcceptedOptions<Scope> {
  return {
    jobId: options.jobId,
    execution: options.execution,
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    parentJobId: options.parentJobId,
    workflowId: options.workflowId,
    workflowSlotId: options.workflowSlotId,
    terminal,
    diagnostics: record.diagnostics,
  };
}

export function appendProviderTerminalInCommit<Scope>(
  c: CommitContext<Scope>,
  terminal: ProviderTerminalEventBody,
  options: RuntimeIngestOptions,
): void {
  const materialized = materializeProviderTerminalInCommit(c, terminal, options);
  appendJobExecutionOutcomeAccepted(
    c,
    terminalRecordOptions(options, materialized.terminal, {
      diagnostics: materialized.diagnostics,
    }),
  );
}

function appendTerminalWithOutcomePlan<Scope>(
  c: CommitContext<Scope>,
  plan: RuntimeIngestPlan,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs: number;
    readonly diagnostics?: JobTerminalDiagnostics;
  },
): void {
  const outcome = materializePlannedOutcomeInCommit(c, plan);
  appendJobExecutionOutcomeAccepted(
    c,
    terminalRecordOptions(
      options,
      {
        content: record.content,
        durationMs: record.durationMs,
        outcome,
      },
      {
        diagnostics: record.diagnostics,
      },
    ),
  );
}

export function appendConversationInterruptedTerminalInCommit<Scope>(
  c: CommitContext<Scope>,
  fault: ConversationInterruptedFault,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs: number;
    readonly diagnostics?: JobTerminalDiagnostics;
  },
): void {
  appendTerminalWithOutcomePlan(c, planConversationInterrupted(fault, options), options, record);
}

export function appendJobRecoveryFaultTerminalInCommit<Scope>(
  c: CommitContext<Scope>,
  fault: JobRecoveryFault,
  options: RuntimeIngestOptions,
  record: {
    readonly content: string;
    readonly durationMs: number;
    readonly diagnostics?: JobTerminalDiagnostics;
  },
): void {
  appendTerminalWithOutcomePlan(c, planJobRecoveryFault(fault, options), options, record);
}
