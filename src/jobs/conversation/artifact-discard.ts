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
  const handles = entry.artifactHandles
    .filter((artifact) => artifact.execution === (opts.execution ?? entry.execution))
    .map((artifact) => artifact.handle);
  if (
    handles.length === 0 &&
    entry.conversationRef !== undefined &&
    bound.artifacts.kind === 'managed' &&
    bound.artifacts.locateArtifact !== undefined
  ) {
    const located = bound.artifacts.locateArtifact({
      conversationRef: entry.conversationRef,
      runtime,
    });
    if (located !== null) {
      return [located];
    }
  }
  return handles;
}
