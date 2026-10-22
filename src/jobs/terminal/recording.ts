import type { CauseRefToken, ResolvableCauseRef } from '../../causality/cause-ref.js';
import type { CommitContext } from '../../store/append.js';
import type { ResolvableCoralEventInput } from '../../store/envelope.js';
import type { TerminalOutcomeInput } from '../outcome.js';
import { buildJobEventRefs } from '../refs.js';
import {
  normalizeJobTerminal,
  type JobExecutionOutcomeAcceptedInputBody,
  type JobExecutionEndedInputBody,
} from './result.js';
import type { JobTerminalDiagnostics, JobTerminalInput } from '../records.js';

export function failedTerminalOutcome<Scope>(causeRef: CauseRefToken<Scope>): TerminalOutcomeInput<Scope> {
  return { kind: 'failed', causeRef } as TerminalOutcomeInput<Scope>;
}

export interface JobExecutionEventOptions {
  readonly jobId: string;
  readonly execution: number;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowId?: string;
  readonly workflowSlotId?: string;
}

export interface JobExecutionOutcomeAcceptedOptions<Scope = never> extends JobExecutionEventOptions {
  readonly terminal: JobTerminalInput<Scope>;
  readonly diagnostics?: JobTerminalDiagnostics;
}

function executionEvent<Scope, Body>(
  options: JobExecutionEventOptions,
  type: string,
  body: Body,
): ResolvableCoralEventInput<Scope, Body> {
  return {
    type,
    body,
    stream: { kind: 'job', id: options.jobId },
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: buildJobEventRefs({
      jobId: options.jobId,
      parentJobId: options.parentJobId,
      workflowId: options.workflowId,
      workflowSlotId: options.workflowSlotId,
    }),
  };
}

export function appendJobExecutionOutcomeAccepted<Scope>(
  c: CommitContext<Scope>,
  options: JobExecutionOutcomeAcceptedOptions<Scope>,
): CauseRefToken<Scope> {
  return c.append(
    executionEvent<Scope, JobExecutionOutcomeAcceptedInputBody<Scope>>(options, 'job.execution.outcome.accepted', {
      execution: options.execution,
      terminal: normalizeJobTerminal(options.terminal),
      diagnostics: options.diagnostics,
    }),
  );
}

export function appendJobExecutionEnded<Scope>(
  c: CommitContext<Scope>,
  options: JobExecutionEventOptions & { causeRef: ResolvableCauseRef<Scope> },
): CauseRefToken<Scope> {
  return c.append(
    executionEvent<Scope, JobExecutionEndedInputBody<Scope>>(options, 'job.execution.ended', {
      execution: options.execution,
      causeRef: options.causeRef,
    }),
  );
}
