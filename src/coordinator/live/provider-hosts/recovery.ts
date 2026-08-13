import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { ContainedProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { ProviderHostEntry } from './state.js';
import { AbortError } from '../../../runtime/abort.js';

function waitForSpawn(
  spawn: Promise<ContainedProviderServerHandle>,
  signal: AbortSignal | undefined,
): Promise<ContainedProviderServerHandle> {
  if (signal === undefined) return spawn;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage: 'provider_host_spawn_wait', reason: signal.reason }));
  }
  return new Promise<ContainedProviderServerHandle>((resolve, reject) => {
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
    spawnProviderServer: (spec: ProviderServerSpec) => Promise<ContainedProviderServerHandle>;
    closeEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ContainedProviderServerHandle) => void;
    createInstanceId: () => string;
    observeRetired: (entry: ProviderHostEntry, instanceId: string) => void;
    signal?: AbortSignal;
  },
): Promise<ContainedProviderServerHandle> {
  if (entry.handle) {
    return waitForSpawn(Promise.resolve(entry.handle), options.signal);
  }
  if (entry.closingError) {
    throw providerHostDrainingError(entry.closingError);
  }
  if (entry.spawnPromise === null) {
    const instanceId = options.createInstanceId();
    entry.instanceId = instanceId;
    let spawned: Promise<ContainedProviderServerHandle>;
    try {
      spawned = options.spawnProviderServer(entry.spec);
    } catch (error: unknown) {
      try {
        if (entry.containment !== null) {
          await options.closeEntry(entry, 'failed during spawn or initialization');
        }
      } finally {
        retireUninstalledInstance(entry, instanceId, options.observeRetired);
      }
      throw error;
    }
    const initialization = initializeProviderServerHandle(entry, spawned, options);
    const ownedInitialization = initialization.catch(async (error: unknown) => {
      if (entry.spawnPromise === ownedInitialization) entry.spawnPromise = null;
      try {
        if (entry.containment !== null && entry.closePromise === null) {
          await options.closeEntry(entry, 'failed during spawn or initialization');
        }
      } finally {
        if (entry.handle === null) retireUninstalledInstance(entry, instanceId, options.observeRetired);
      }
      throw error;
    });
    entry.spawnPromise = ownedInitialization;
    void ownedInitialization.then(
      () => {
        if (entry.spawnPromise === ownedInitialization) entry.spawnPromise = null;
      },
      () => {},
    );
  }
  return waitForSpawn(entry.spawnPromise, options.signal);
}

async function initializeProviderServerHandle(
  entry: ProviderHostEntry,
  spawned: Promise<ContainedProviderServerHandle>,
  options: {
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ContainedProviderServerHandle) => void;
    closeEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
    observeRetired: (entry: ProviderHostEntry, instanceId: string) => void;
  },
): Promise<ContainedProviderServerHandle> {
  const handle = await spawned;
  entry.containment = handle.containmentIdentity;
  entry.handle = handle;
  const instanceId = entry.instanceId;
  const retire = () => {
    // Starting unexpected-exit cleanup first lets its synchronous prefix retain the handle and containment
    // identities before process-death bookkeeping removes the host as an acquisition candidate.
    if (entry.closePromise === null) {
      void options.closeEntry(entry, 'exited unexpectedly').catch(() => {});
    }
    if (instanceId !== null && entry.handle === handle && entry.instanceId === instanceId) {
      options.observeRetired(entry, instanceId);
      entry.handle = null;
      entry.instanceId = null;
    }
  };
  void handle.closePromise.then(retire, retire);
  // The entry-owned close operation, not an acquisition caller, owns a spawn that completes during drain.
  const closingError = entry.closingError;
  if (closingError !== null) {
    throw providerHostDrainingError(closingError);
  }
  options.attachHostNotificationListener(entry, handle);
  return handle;
}

function providerHostDrainingError(closingError: Error): Error {
  return new Error(`provider_host_draining: ${closingError.message}`, { cause: closingError });
}

function retireUninstalledInstance(
  entry: ProviderHostEntry,
  instanceId: string,
  observeRetired: (entry: ProviderHostEntry, instanceId: string) => void,
): void {
  if (entry.instanceId !== instanceId) return;
  observeRetired(entry, instanceId);
  entry.instanceId = null;
}
