import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';
import type { WorkflowRecoveryFinalizer } from '#src/workflow/recover.js';

/** Adapts recovery-finalizer doubles at the shared test boundary. */
export function withNoopWorkflowArtifactEnsure<T extends (intent: WorkflowFinalizationIntent) => void>(
  finalize: T,
): T & WorkflowRecoveryFinalizer {
  return finalize;
}
