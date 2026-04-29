import type { AppendedEvent } from '#src/store/append.js';
import type { JobStore } from '#src/jobs/job-store.js';
import type { JobTerminalInput } from '#src/jobs/terminal/result.js';
import type { JobTerminalDiagnostics } from '#src/jobs/terminal/result.js';
import type { JobContinuitySnapshot } from '#src/jobs/continuity.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import type { CoralEventInput } from '#src/store/envelope.js';

export function commitJobInputs(store: JobStore, inputs: readonly CoralEventInput[]): AppendedEvent[] {
  return store.commit((c) => {
    for (const input of inputs) {
      c.append(input);
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
  sessionId: string | null,
  terminal: JobTerminalInput,
  phaseOrOptions:
    | 'completed'
    | 'error'
    | 'aborted'
    | {
        diagnostics?: JobTerminalDiagnostics;
        continuity?: JobContinuitySnapshot | null;
      } = {},
  maybeOptions: {
    diagnostics?: JobTerminalDiagnostics;
    continuity?: JobContinuitySnapshot | null;
  } = {},
): number {
  const options = typeof phaseOrOptions === 'string' ? maybeOptions : phaseOrOptions;
  const status = store.readStatus(jobId);
  const [appended] = store.commit((c) => {
    appendJobTerminalRecorded(c, {
      jobId,
      sessionId,
      namespace: status?.backendNamespace,
      project: status?.projectRoot,
      terminal,
      diagnostics: options.diagnostics,
      continuity: options.continuity ?? null,
    });
    return undefined;
  });
  return appended?.seq ?? 0;
}
