import type { JobTerminal } from '../jobs/records.js';
import { describeTerminalOutcome } from '../jobs/outcome.js';
import { describeCauseRef, type CauseRefEventStore } from '../jobs/read/cause-ref-render.js';
import { assertNever } from '../infra/error-format.js';

export {
  WorkflowExecutionError,
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  failureMetadata,
  failureMetadataForAtom,
  type CoralDispatchInput,
  type LaunchedAtom,
  type PipelineResult,
  type ResumeInput,
  type StepDetail,
  type WaitFailure,
  type WaitInternalState,
  type WorkflowExecutionPort,
  type WorkflowSessionHandle,
} from './internal/execution-contract.js';

export function describeTerminalFailure(
  result: JobTerminal,
  options: { store?: CauseRefEventStore; exitCode?: number | null } = {},
): string {
  switch (result.outcome.kind) {
    case 'failed':
      return options.store
        ? describeCauseRef(result.outcome.causeRef, options.store, result.outcome)
        : describeTerminalOutcome(result.outcome);
    case 'job_fault':
    case 'aborted':
      return describeTerminalOutcome(result.outcome);
    case 'completed':
    case 'provider_exit': {
      const content = result.content.trim();
      if (content.length > 0) {
        return content;
      }
      const exitCode = options.exitCode ?? (result.outcome.kind === 'provider_exit' ? result.outcome.code : undefined);
      return exitCode === undefined || exitCode === null ? 'unknown error' : `exited with code ${exitCode}`;
    }
    default:
      return assertNever(result.outcome);
  }
}

export function formatStepOutput(results: Array<{ tagName: string; output: string }>): string {
  if (results.length === 0) return '';
  if (results.length === 1) return results[0].output;
  return results.map((result) => `<${result.tagName}>\n${result.output}\n</${result.tagName}>`).join('\n\n');
}

export function toSessionHandles(
  launchedAtoms: readonly { providerName: string; sessionId: string }[],
): Array<{ providerName: string; sessionId: string }> {
  const seen = new Set<string>();
  const handles: Array<{ providerName: string; sessionId: string }> = [];

  for (const atom of launchedAtoms) {
    const key = `${atom.providerName}:${atom.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push({ providerName: atom.providerName, sessionId: atom.sessionId });
  }

  return handles;
}
