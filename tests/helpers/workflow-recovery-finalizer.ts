import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import type { WorkflowRecoveryFinalizer } from '#src/workflow/recover.js';

/** Adds the required no-op artifact seam to recovery-finalizer doubles whose tests do not inspect exports. */
export function withNoopWorkflowArtifactEnsure<T extends (intent: WorkflowFinalizationIntent) => void>(
  finalize: T,
): T & WorkflowRecoveryFinalizer {
  return Object.assign(finalize, { ensureArtifact: () => undefined });
}
