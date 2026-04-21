import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderServerHandle } from '../durable-transport.js';
import type { ProviderHostEntry } from './pool.js';

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

export function readClosingError(entry: ProviderHostEntry): Error | null {
  return entry.closingError;
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
    const closingError = readClosingError(entry);
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
