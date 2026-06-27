import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  ProviderArtifactHandle,
  ProviderManagedArtifactCapability,
  ProviderNoArtifactCapability,
} from './contract.js';

const FINAL_UNLINK_ATTEMPTS = 6;
const FINAL_UNLINK_SETTLE_MS = 500;

export function managed(
  impl: Pick<ProviderManagedArtifactCapability, 'discardArtifacts' | 'locateArtifact'>,
): ProviderManagedArtifactCapability {
  return {
    kind: 'managed',
    discardArtifacts: impl.discardArtifacts,
    ...(impl.locateArtifact !== undefined ? { locateArtifact: impl.locateArtifact } : {}),
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
  for (let attempt = 1; attempt <= FINAL_UNLINK_ATTEMPTS; attempt += 1) {
    unlinkAll(handles, runtime);
    if (attempt === FINAL_UNLINK_ATTEMPTS) {
      break;
    }
    await runtime.time.sleep(FINAL_UNLINK_SETTLE_MS);
    if (!handles.some((handle) => safeExists(handle, runtime))) {
      break;
    }
  }
  return { kind: 'discarded' };
}

function unlinkAll(handles: readonly ProviderArtifactHandle[], runtime: ArtifactCleanupRuntime): void {
  for (const handle of handles) {
    try {
      runtime.storage.unlinkSync(handle);
    } catch {
      /* best-effort */
    }
  }
}

function safeExists(handle: ProviderArtifactHandle, runtime: ArtifactCleanupRuntime): boolean {
  try {
    return runtime.storage.existsSync(handle);
  } catch {
    return false;
  }
}
