import type { JobTerminal } from '../jobs/records.js';
import { describeTerminalOutcome } from '../jobs/outcome.js';
import { assertNever } from '../infra/error-format.js';

export function describeTerminalFailure(result: JobTerminal, options: { exitCode?: number | null } = {}): string {
  switch (result.outcome.kind) {
    case 'failed':
    case 'job_fault':
    case 'aborted':
      return describeTerminalOutcome(result.outcome);
    case 'completed':
    case 'provider_exit': {
      const content = result.content.trim();
      if (content.length > 0) {
        return content;
      }
      let exitCode = options.exitCode;
      if (exitCode === undefined && result.outcome.kind === 'provider_exit') {
        exitCode = result.outcome.code;
      }
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
