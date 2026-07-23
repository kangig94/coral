import type { CauseRefToken } from '../../causality/cause-ref.js';
import type { CommitContext } from '../../store/append.js';
import type { ResolvableCoralEventInput } from '../../store/envelope.js';
import type { TerminalOutcomeInput } from '../outcome.js';
import { buildJobEventRefs } from '../refs.js';
import { normalizeJobTerminal, type JobTerminalRecordedInputBody } from './result.js';
import type { JobTerminalDiagnostics, JobTerminalInput } from '../records.js';

export function failedTerminalOutcome<Scope>(causeRef: CauseRefToken<Scope>): TerminalOutcomeInput<Scope> {
  return { kind: 'failed', causeRef } as TerminalOutcomeInput<Scope>;
}

export interface JobTerminalRecordedOptions<Scope = never> {
  readonly jobId: string;
  readonly sessionId?: string | null;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowId?: string;
  readonly workflowSlotId?: string;
  readonly terminal: JobTerminalInput<Scope> | JobTerminalInput;
  readonly diagnostics?: JobTerminalDiagnostics;
}

function jobTerminalRecordedEvent<Scope = never>(
  options: JobTerminalRecordedOptions<Scope>,
): ResolvableCoralEventInput<Scope, JobTerminalRecordedInputBody<Scope>> {
  return {
    type: 'job.terminal.recorded',
    body: {
      terminal: normalizeJobTerminal(options.terminal as JobTerminalInput<Scope>),
      diagnostics: options.diagnostics,
    },
    stream: { kind: 'job', id: options.jobId },
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: buildJobEventRefs({
      jobId: options.jobId,
      sessionId: options.sessionId,
      parentJobId: options.parentJobId,
      workflowId: options.workflowId,
      workflowSlotId: options.workflowSlotId,
    }),
  };
}

export function appendJobTerminalRecorded<Scope>(
  c: CommitContext<Scope>,
  options: JobTerminalRecordedOptions<Scope>,
): CauseRefToken<Scope> {
  return c.append(jobTerminalRecordedEvent(options));
}
