import { createCauseRefRenderer } from '../causality/render.js';
import { renderCauseRefFallback, type CauseRef } from '../causality/cause-ref.js';
import { describeTerminalOutcome, type TerminalOutcome } from '../jobs/outcome.js';
import { defaultEventDescribers } from '../read-model/event-describers.js';
import { openReadCoralStore, type ReadCoralStoreHandle } from './read-store.js';

const causeRefRenderer = createCauseRefRenderer(defaultEventDescribers);

/**
 * Each rendering opens the store and closes it before returning: a store handle kept across a coordinator round
 * trip holds the epoch lock that a format-changing succession must take while that coordinator waits on it.
 */
export function openCliCauseRefRenderer(projectRoot: string): {
  readonly render?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome) => string;
  close(): void;
} {
  return {
    render: (ref, terminalOutcomeDiagnostic) => {
      const hint = terminalOutcomeDiagnostic
        ? `Original terminal outcome: ${describeTerminalOutcome(terminalOutcomeDiagnostic)}`
        : undefined;
      let handle: ReadCoralStoreHandle;
      try {
        handle = openReadCoralStore(projectRoot);
      } catch {
        return renderCauseRefFallback(ref);
      }
      try {
        return causeRefRenderer.describe(ref, handle.store, hint);
      } finally {
        handle.close();
      }
    },
    close: () => {},
  };
}
