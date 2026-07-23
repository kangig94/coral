import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { BoundProvider } from '../providers/bound-provider-contract.js';
import type { ProviderSession } from './entry.js';

/**
 * Resolve the provider native-artifact handles to discard for a session: the
 * in-run recorded handles (optionally narrowed to one job), falling back to a
 * conversationRef-based locate when no handle was captured at run time.
 *
 * Returns handles only; invoking `discardArtifacts` is reserved for the
 * lifecycle reactor (see `tests/invariants/cleanup-discipline.test.ts`).
 */
export function collectArtifactHandles(
  entry: ProviderSession,
  bound: BoundProvider,
  runtime: ArtifactCleanupRuntime,
  opts: { jobId?: string } = {},
): string[] {
  const handles = entry.artifactHandles
    .filter((artifact) => opts.jobId === undefined || artifact.sourceJobId === opts.jobId)
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
