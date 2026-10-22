import type { AppendedEvent } from '#src/store/append.js';
import type { JobStore } from '#src/jobs/store.js';
import type { JobTerminal, JobTerminalDiagnostics } from '#src/jobs/records.js';
import { appendJobExecutionOutcomeAccepted, appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import type { CoralEventInput } from '#src/store/envelope.js';

export function commitJobInputs(store: JobStore, inputs: readonly CoralEventInput[]): AppendedEvent[] {
  return store.commit((c) => {
    for (const input of inputs) {
      c.append(input as Parameters<typeof c.append>[0]);
    }
    return undefined;
  });
}

export function commitJobInput(store: JobStore, input: CoralEventInput): AppendedEvent[] {
  return commitJobInputs(store, [input]);
}

export function commitJobTerminal(
  store: JobStore,
  jobId: string,
  execution: number,
  terminal: JobTerminal,
  phaseOrOptions:
    | 'completed'
    | 'error'
    | 'aborted'
    | {
        diagnostics?: JobTerminalDiagnostics;
      } = {},
  maybeOptions: {
    diagnostics?: JobTerminalDiagnostics;
  } = {},
): number {
  const options = typeof phaseOrOptions === 'string' ? maybeOptions : phaseOrOptions;
  const status = store.readStatus(jobId);
  const appended = store.commit((c) => {
    const accepted = appendJobExecutionOutcomeAccepted(c, {
      jobId,
      execution,
      namespace: status?.backendNamespace ?? undefined,
      project: status?.projectRoot,
      terminal,
      diagnostics: options.diagnostics,
    });
    appendJobExecutionEnded(c, { jobId, execution, causeRef: accepted });
    return undefined;
  });
  return appended.at(-1)?.seq ?? 0;
}
