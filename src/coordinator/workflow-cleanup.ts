import type { ArtifactCleanupRuntime } from '../providers/provider-contracts.js';
import type { ProviderSpec } from '../providers/contract.js';
import { getProviderCleanup } from '../providers/spec-compat.js';
import type { Runtime } from '../runtime/ports.js';
import { errorMessage } from '../shared/utils.js';
import type { WorkflowSessionHandle } from '../workflow/api.js';

export interface WorkflowSessionCleanupDeps {
  resolveConversationRef(providerName: string, sessionId: string): string | undefined;
  get(providerName: string): ProviderSpec | undefined;
  cleanupRuntime: ArtifactCleanupRuntime;
  onError(message: string): void;
}

export function toArtifactCleanupRuntime(runtime: Runtime): ArtifactCleanupRuntime {
  return {
    storage: runtime.storage,
    env: runtime.env,
  };
}

/**
 * Pure dispatch core for `ExecutionService.cleanupWorkflowSessions`.
 * Groups handles by provider, resolves conversation refs, and fires cleanup
 * per-provider. Exported so tests can exercise grouping and error surfacing
 * without standing up a full ExecutionService.
 */
export function dispatchWorkflowSessionCleanup(
  sessions: readonly WorkflowSessionHandle[],
  deps: WorkflowSessionCleanupDeps,
): void {
  if (sessions.length === 0) return;

  const refsByProvider = new Map<string, Set<string>>();
  for (const handle of sessions) {
    const ref = deps.resolveConversationRef(handle.providerName, handle.sessionId);
    if (!ref) continue;
    const bucket = refsByProvider.get(handle.providerName) ?? new Set<string>();
    bucket.add(ref);
    refsByProvider.set(handle.providerName, bucket);
  }
  if (refsByProvider.size === 0) return;

  for (const [providerName, refs] of refsByProvider) {
    const artifactCleanup = getProviderCleanup(deps.get(providerName));
    if (!artifactCleanup?.cleanupSessions) continue;
    void artifactCleanup.cleanupSessions(deps.cleanupRuntime, [...refs]).catch((error: unknown) => {
      deps.onError(`Provider ${providerName} session cleanup failed: ${errorMessage(error)}`);
    });
  }
}
