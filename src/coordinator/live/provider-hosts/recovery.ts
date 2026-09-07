import type { ProviderServerSpec } from '../../../providers/contract.js';
import type {
  ContainedProviderServerHandle,
  HeldProviderServerSpawn,
  ProviderServerFailedSpawnCleanupTerminalDisposition,
} from '../../../providers/app-server-transport.js';
import type { ProviderHostEntry } from './state.js';
import { AbortError } from '../../../runtime/abort.js';

class ProviderServerSpawnCleanupSettledError extends Error {
  readonly originalFailure: Error;
  readonly disposition: ProviderServerFailedSpawnCleanupTerminalDisposition;

  constructor(originalFailure: Error, disposition: ProviderServerFailedSpawnCleanupTerminalDisposition) {
    super(originalFailure.message, { cause: originalFailure });
    this.name = 'ProviderServerSpawnCleanupSettledError';
    this.originalFailure = originalFailure;
    this.disposition = disposition;
    Object.setPrototypeOf(this, ProviderServerSpawnCleanupSettledError.prototype);
  }
}

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
    spawnProviderServer: (spec: ProviderServerSpec) => Promise<ContainedProviderServerHandle | HeldProviderServerSpawn>;
    closeEntry: (entry: ProviderHostEntry, detail: string) => Promise<unknown>;
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ContainedProviderServerHandle) => void;
    createInstanceId: () => string;
    observeRetired: (entry: ProviderHostEntry, instanceId: string) => void;
    abandonUninstalled: (entry: ProviderHostEntry, instanceId: string) => void;
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
    entry.spawnCleanupDisposition = null;
    let spawned: Promise<ContainedProviderServerHandle | HeldProviderServerSpawn>;
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
      const cleanup = error instanceof ProviderServerSpawnCleanupSettledError ? error.disposition : null;
      if (entry.spawnPromise === ownedInitialization) entry.spawnPromise = null;
      try {
        if (cleanup?.kind !== 'operator-abandoned' && entry.containment !== null && entry.closePromise === null) {
          await options.closeEntry(entry, 'failed during spawn or initialization');
        }
      } finally {
        if (entry.handle === null) {
          if (cleanup?.kind === 'operator-abandoned') {
            abandonUninstalledInstance(entry, instanceId, options.abandonUninstalled);
          } else {
            retireUninstalledInstance(entry, instanceId, options.observeRetired);
          }
        }
      }
      throw error instanceof ProviderServerSpawnCleanupSettledError ? error.originalFailure : error;
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
  spawned: Promise<ContainedProviderServerHandle | HeldProviderServerSpawn>,
  options: {
    attachHostNotificationListener: (entry: ProviderHostEntry, handle: ContainedProviderServerHandle) => void;
    closeEntry: (entry: ProviderHostEntry, detail: string) => Promise<unknown>;
    observeRetired: (entry: ProviderHostEntry, instanceId: string) => void;
  },
): Promise<ContainedProviderServerHandle> {
  const disposition = await spawned;
  if (isHeldProviderServerSpawn(disposition)) {
    await disposition.successor.settlement;
    const cleanup = entry.spawnCleanupDisposition;
    if (cleanup === null) throw disposition.error;
    throw new ProviderServerSpawnCleanupSettledError(disposition.error, cleanup);
  }
  const handle = disposition;
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

function isHeldProviderServerSpawn(
  disposition: ContainedProviderServerHandle | HeldProviderServerSpawn,
): disposition is HeldProviderServerSpawn {
  return 'kind' in disposition && (disposition.kind === 'held-alive' || disposition.kind === 'held-unobservable');
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

function abandonUninstalledInstance(
  entry: ProviderHostEntry,
  instanceId: string,
  abandonUninstalled: (entry: ProviderHostEntry, instanceId: string) => void,
): void {
  if (entry.instanceId !== instanceId) return;
  abandonUninstalled(entry, instanceId);
  entry.containment = null;
  entry.instanceId = null;
}
