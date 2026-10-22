import type { ArtifactCleanupRuntime } from '../../providers/contract.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { JobConversation } from './entry.js';

/**
 * Returns handles only; invoking `discardArtifacts` is reserved for the
 * lifecycle reactor (see `tests/invariants/architecture-boundary.test.ts`).
 */
export function collectArtifactHandles(
  entry: JobConversation,
  bound: BoundProvider,
  runtime: ArtifactCleanupRuntime,
  opts: { execution?: number } = {},
): string[] {
  let handles = entry.artifactHandles
    .filter((artifact) => artifact.execution === (opts.execution ?? entry.execution))
    .map((artifact) => artifact.handle);
  if (handles.length === 0) {
    const latestArtifactExecution = entry.artifactHandles.reduce((latest, artifact) => Math.max(latest, artifact.execution), 0);
    handles = entry.artifactHandles.filter(artifact => artifact.execution === latestArtifactExecution).map(artifact => artifact.handle);
  }
  if (handles.length === 0) handles = [...(entry.retentionDiscard.attempts.at(-1)?.handles ?? [])];
  if (
    entry.conversationRef !== undefined &&
    bound.artifacts.kind === 'managed' &&
    bound.artifacts.locateArtifact !== undefined
  ) {
    const located = bound.artifacts.locateArtifact({
      conversationRef: entry.conversationRef,
      runtime,
    });
    if (located !== null) {
      handles.push(located);
    }
  }
  return [...new Set(handles)];
}
