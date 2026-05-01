import { createCauseRefRenderer } from '../causality/render.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { describeTerminalOutcome, type TerminalOutcome } from '../jobs/outcome.js';
import { defaultEventDescribers } from '../read-model/event-describers.js';
import { getSharedReadCoralStore } from './read-store.js';

const causeRefRenderer = createCauseRefRenderer(defaultEventDescribers);

export function openCliCauseRefRenderer(projectRoot: string): {
  readonly render?: (ref: CauseRef, terminalOutcomeDiagnostic?: TerminalOutcome) => string;
  close(): void;
} {
  try {
    const store = getSharedReadCoralStore(projectRoot, { announceMissing: false });
    return {
      render: (ref, terminalOutcomeDiagnostic) => {
        const hint = terminalOutcomeDiagnostic
          ? `Original terminal outcome: ${describeTerminalOutcome(terminalOutcomeDiagnostic)}`
          : undefined;
        return causeRefRenderer.describe(ref, store, hint);
      },
      close: () => {},
    };
  } catch {
    return {
      close: () => {},
    };
  }
}
