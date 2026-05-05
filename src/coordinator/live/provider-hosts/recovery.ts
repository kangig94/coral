import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';
import type { ProviderHostEntry } from './state.js';

export function cloneSpec(spec: ProviderServerSpec): ProviderServerSpec {
  return {
    ...spec,
    args: [...spec.args],
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.initializeRequest
      ? { initializeRequest: { ...spec.initializeRequest, params: { ...spec.initializeRequest.params } } }
      : {}),
    ...(spec.shutdownCapability ? { shutdownCapability: { ...spec.shutdownCapability } } : {}),
  };
}

export async function ensureProviderServerHandle(
  entry: ProviderHostEntry,
  options: {
    spawnProviderServer: (spec: ProviderServerSpec) => Promise<ProviderServerHandle>;
    runtime: Pick<Runtime, 'time'>;
    shutdownHandle: (handle: ProviderServerHandle, spec: ProviderServerSpec) => Promise<void>;
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ProviderServerHandle) => void;
    clearIdleTimer: (entry: ProviderHostEntry) => void;
  },
): Promise<ProviderServerHandle> {
  if (entry.handle) {
    return entry.handle;
  }
  if (entry.closingError) {
    throw entry.closingError;
  }
  if (entry.spawnPromise) {
    return entry.spawnPromise;
  }

  entry.spawnPromise = options.spawnProviderServer(entry.spec);

  try {
    const handle = await entry.spawnPromise;
    // The host can be marked closing while the spawn promise is pending.
    const closingError = entry.closingError as Error | null;
    if (closingError !== null) {
      await options.shutdownHandle(handle, entry.spec).catch(() => {});
      throw new Error(closingError.message, { cause: closingError });
    }
    entry.handle = handle;
    options.attachHostNotificationListener(entry, handle);
    void handle.closePromise.finally(() => {
      if (entry.handle === handle) {
        entry.handle = null;
      }
      options.clearIdleTimer(entry);
      entry.disposeHostNotifications?.();
      entry.disposeHostNotifications = null;
      entry.hostStats = null;
    });
    return handle;
  } finally {
    entry.spawnPromise = null;
  }
}
