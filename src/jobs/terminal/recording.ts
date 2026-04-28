import type { CauseRefToken } from '../../causality/cause-ref.js';
import type { CommitContext } from '../../store/append.js';
import type { ResolvableCoralEventInput } from '../../store/envelope.js';
import type { JobContinuitySnapshot } from '../continuity.js';
import type { TerminalOutcomeInput } from '../outcome.js';
import {
  normalizeJobTerminal,
  type JobTerminalDiagnostics,
  type JobTerminalInput,
  type JobTerminalRecordedInputBody,
} from './result.js';

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
  readonly workflowSlotId?: string;
  readonly terminal: JobTerminalInput<Scope>;
  readonly diagnostics?: JobTerminalDiagnostics;
  readonly continuity?: JobContinuitySnapshot | null;
}

export function jobTerminalRecordedEvent<Scope = never>(
  options: JobTerminalRecordedOptions<Scope>,
): ResolvableCoralEventInput<Scope, JobTerminalRecordedInputBody<Scope>> {
  return {
    type: 'job.terminal.recorded',
    bodyVersion: 1,
    body: {
      terminal: normalizeJobTerminal(options.terminal),
      diagnostics: options.diagnostics,
      continuity: options.continuity ?? null,
    },
    stream: { kind: 'job', id: options.jobId },
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: {
      jobId: options.jobId,
      ...(options.sessionId === undefined || options.sessionId === null ? {} : { sessionId: options.sessionId }),
      ...(options.parentJobId === undefined ? {} : { parentJobId: options.parentJobId }),
      ...(options.workflowSlotId === undefined ? {} : { workflowSlotId: options.workflowSlotId }),
    },
  };
}

export function appendJobTerminalRecorded<Scope>(
  c: CommitContext<Scope>,
  options: JobTerminalRecordedOptions<Scope>,
): CauseRefToken<Scope> {
  return c.append(jobTerminalRecordedEvent(options));
}
