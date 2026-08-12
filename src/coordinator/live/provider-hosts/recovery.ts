import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { ProviderHostEntry } from './state.js';
import { AbortError } from '../../../runtime/abort.js';

function waitForSpawn(
  spawn: Promise<ProviderServerHandle>,
  signal: AbortSignal | undefined,
): Promise<ProviderServerHandle> {
  if (signal === undefined) return spawn;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage: 'provider_host_spawn_wait', reason: signal.reason }));
  }
  return new Promise<ProviderServerHandle>((resolve, reject) => {
    const onAbort = () => reject(new AbortError({ stage: 'provider_host_spawn_wait', reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    spawn.then(
      (handle) => {
        signal.removeEventListener('abort', onAbort);
        resolve(handle);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider host spawn failed.', { cause: error }));
      },
    );
  });
}

export function cloneSpec(spec: ProviderServerSpec): ProviderServerSpec {
  return immutableSnapshot(spec);
}

function immutableSnapshot<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableSnapshot(entry))) as Value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableSnapshot(entry)])),
    ) as Value;
  }
  return value;
}

export async function ensureProviderServerHandle(
  entry: ProviderHostEntry,
  options: {
    spawnProviderServer: (spec: ProviderServerSpec) => Promise<ProviderServerHandle>;
    runtime: Pick<Runtime, 'time'>;
    shutdownHandle: (handle: ProviderServerHandle, spec: ProviderServerSpec) => Promise<void>;
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ProviderServerHandle) => void;
    clearIdleTimer: (entry: ProviderHostEntry) => void;
    removeEntry: (entry: ProviderHostEntry) => void;
    createInstanceId: () => string;
    observeRetired?: (entry: ProviderHostEntry, instanceId: string) => void;
    signal?: AbortSignal;
  },
): Promise<ProviderServerHandle> {
  if (entry.handle) {
    return waitForSpawn(Promise.resolve(entry.handle), options.signal);
  }
  if (entry.closingError) {
    throw entry.closingError;
  }
  if (entry.spawnPromise === null) {
    const instanceId = options.createInstanceId();
    entry.instanceId = instanceId;
    let spawned: Promise<ProviderServerHandle>;
    try {
      spawned = options.spawnProviderServer(entry.spec);
    } catch (error: unknown) {
      options.observeRetired?.(entry, instanceId);
      if (entry.instanceId === instanceId) entry.instanceId = null;
      throw error;
    }
    const initialization = initializeProviderServerHandle(entry, spawned, options);
    entry.spawnPromise = initialization;
    void initialization.then(
      () => {
        if (entry.spawnPromise === initialization) entry.spawnPromise = null;
      },
      () => {
        if (entry.spawnPromise === initialization) {
          entry.spawnPromise = null;
          options.observeRetired?.(entry, instanceId);
          if (entry.handle === null && entry.instanceId === instanceId) entry.instanceId = null;
        }
      },
    );
  }
  return waitForSpawn(entry.spawnPromise, options.signal);
}

async function initializeProviderServerHandle(
  entry: ProviderHostEntry,
  spawned: Promise<ProviderServerHandle>,
  options: {
    shutdownHandle: (handle: ProviderServerHandle, spec: ProviderServerSpec) => Promise<void>;
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ProviderServerHandle) => void;
    clearIdleTimer: (entry: ProviderHostEntry) => void;
    removeEntry: (entry: ProviderHostEntry) => void;
    observeRetired?: (entry: ProviderHostEntry, instanceId: string) => void;
  },
): Promise<ProviderServerHandle> {
  const handle = await spawned;
  // The entry-owned close operation, not an acquisition caller, owns a spawn that completes during drain.
  const closingError = entry.closingError;
  if (closingError !== null) {
    await options.shutdownHandle(handle, entry.spec).catch(() => {});
    throw new Error(closingError.message, { cause: closingError });
  }
  entry.handle = handle;
  options.attachHostNotificationListener(entry, handle);
  const instanceId = entry.instanceId;
  const cleanup = () => {
    if (entry.handle === handle) {
      if (instanceId !== null) options.observeRetired?.(entry, instanceId);
      entry.handle = null;
      entry.instanceId = null;
    }
    options.clearIdleTimer(entry);
    options.removeEntry(entry);
    entry.disposeHostNotifications?.();
    entry.disposeHostNotifications = null;
    entry.hostStats = null;
  };
  void handle.closePromise.then(cleanup, cleanup);
  return handle;
}
