import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  ProviderArtifactHandle,
  ProviderManagedArtifactCapability,
  ProviderNoArtifactCapability,
} from './contract.js';

export function managed(
  impl: Pick<ProviderManagedArtifactCapability, 'discardArtifacts'>,
): ProviderManagedArtifactCapability {
  return {
    kind: 'managed',
    discardArtifacts: impl.discardArtifacts,
  };
}

export function none(reason: string): ProviderNoArtifactCapability {
  return {
    kind: 'none',
    reason,
  };
}

export async function discardRecordedArtifacts(
  handles: readonly ProviderArtifactHandle[],
  runtime: ArtifactCleanupRuntime,
): Promise<DiscardOutcome> {
  if (handles.length === 0) {
    return { kind: 'skipped_no_handles' };
  }
  for (const handle of handles) {
    try {
      runtime.storage.unlinkSync(handle);
    } catch {
      /* best-effort */
    }
  }
  return { kind: 'discarded' };
}
