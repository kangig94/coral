import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderDefinition } from '../providers/define.js';
import type { SessionEntry } from './entry.js';

/**
 * Resolve the provider native-artifact handles to discard for a session: the
 * in-run recorded handles (optionally narrowed to one job), falling back to a
 * conversationRef-based locate when no handle was captured at run time.
 *
 * Returns handles only; invoking `discardArtifacts` is reserved for the
 * lifecycle reactor (see `tests/invariants/cleanup-discipline.test.ts`).
 */
export function collectArtifactHandles(
  entry: SessionEntry,
  provider: ProviderDefinition,
  runtime: ArtifactCleanupRuntime,
  opts: { jobId?: string } = {},
): string[] {
  // A handle whose sourceJobId is absent predates per-job tracking and belongs to
  // every job scope, so it is always included even when narrowing to one job.
  const handles = entry.artifactHandles
    .filter(
      (artifact) =>
        opts.jobId === undefined || artifact.sourceJobId === undefined || artifact.sourceJobId === opts.jobId,
    )
    .map((artifact) => artifact.handle);
  if (
    handles.length === 0 &&
    entry.conversationRef !== undefined &&
    provider.artifacts.kind === 'managed' &&
    provider.artifacts.locateArtifact !== undefined
  ) {
    const located = provider.artifacts.locateArtifact(entry.conversationRef, runtime);
    if (located !== null) {
      return [located];
    }
  }
  return handles;
}
