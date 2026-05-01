import { raceTimeout } from '../../../infra/async.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';
import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { Runtime, TimePort } from '../../../runtime/ports.js';
import { clearIdleTimer } from './idle.js';
import type { ProviderHostEntry } from './state.js';

const GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS = 5_000;

export function waitForTimeout<T>(timeoutMs: number, value: T, time: Pick<TimePort, 'setTimeout'>): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = time.setTimeout(() => resolve(value), timeoutMs);
    timer.unref?.();
  });
}

export function waitForCloseWithin(
  closed: Promise<Error | void>,
  timeoutMs: number,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
): Promise<boolean> {
  return raceTimeout(closed, timeoutMs, time);
}

export async function closeAllProviderServerEntries(
  entries: Map<string, ProviderHostEntry>,
  detail: string,
  closeProviderServerEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>,
): Promise<void> {
  const snapshot = [...entries.values()];
  await Promise.all(snapshot.map((entry) => closeProviderServerEntry(entry, detail)));
}

export async function closeProviderServerEntry(
  entry: ProviderHostEntry,
  detail: string,
  options: {
    runtime: Pick<Runtime, 'time'>;
    entries: Map<string, ProviderHostEntry>;
    shutdownHandle: (handle: ProviderServerHandle, spec: ProviderServerSpec) => Promise<void>;
  },
): Promise<void> {
  clearIdleTimer(entry, options.runtime.time);
  entry.disposeHostNotifications?.();
  entry.disposeHostNotifications = null;
  entry.hostStats = null;
  entry.closingError ??= new Error(`Provider server ${entry.spec.provider} ${detail}`);
  if (options.entries.get(entry.hostKey) === entry) {
    options.entries.delete(entry.hostKey);
  }

  const waiters = entry.waiters.splice(0, entry.waiters.length);
  for (const waiter of waiters) {
    waiter.reject(entry.closingError);
  }
  entry.leaseHeld = false;
  entry.sharedLeaseCount = 0;

  const handle = entry.handle;
  entry.handle = null;
  if (handle) {
    await options.shutdownHandle(handle, entry.spec).catch(() => {});
    return;
  }

  const pendingSpawn = entry.spawnPromise;
  if (!pendingSpawn) {
    return;
  }

  const spawnedHandle = await pendingSpawn.catch(() => null);
  if (spawnedHandle) {
    await options.shutdownHandle(spawnedHandle, entry.spec).catch(() => {});
  }
}

export async function shutdownHandle(
  handle: ProviderServerHandle,
  spec: ProviderServerSpec,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
): Promise<void> {
  const capability = spec.shutdownCapability;
  if (capability) {
    const closedGracefully = await tryGracefulShutdown(handle, capability, time);
    if (closedGracefully) {
      return;
    }
  }

  await handle.close().catch(() => {});
}

export async function tryGracefulShutdown(
  handle: ProviderServerHandle,
  capability: NonNullable<ProviderServerSpec['shutdownCapability']>,
  time: Pick<Runtime['time'], 'setTimeout' | 'clearTimeout'>,
): Promise<boolean> {
  handle.markExpectedClose();

  try {
    const outcome = await Promise.race([
      handle.rpc.request(capability.method, {}).then(() => 'rpc' as const),
      handle.closePromise.then(() => 'closed' as const),
      waitForTimeout(capability.timeoutMs, 'timeout' as const, time),
    ]);
    if (outcome === 'timeout') {
      return false;
    }
    if (outcome === 'rpc') {
      return waitForCloseWithin(handle.closePromise, GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS, time);
    }
    return true;
  } catch {
    return waitForCloseWithin(handle.closePromise, capability.timeoutMs, time);
  }
}
