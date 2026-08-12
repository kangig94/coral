import { raceTimeout } from '../../../infra/async.js';
import type { ProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import { clearIdleTimer } from './idle.js';
import type { ProviderHostEntry } from './state.js';

const GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS = 5_000;

function waitForTimeout<T>(timeoutMs: number, value: T, time: Pick<TimePort, 'setTimeout'>): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = time.setTimeout(() => resolve(value), timeoutMs);
    timer.unref?.();
  });
}

function waitForCloseWithin(
  closed: Promise<Error | void>,
  timeoutMs: number,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
): Promise<boolean> {
  return raceTimeout(closed, timeoutMs, time);
}

export async function closeAllProviderServerEntries(
  entries: Map<string, ProviderHostEntry>,
  detail: string,
  closeProviderServerEntry: (
    entry: ProviderHostEntry,
    detail: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const snapshot = [...entries.values()];
  await Promise.all(snapshot.map((entry) => closeProviderServerEntry(entry, detail, options)));
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

  const handle = entry.handle;
  if (handle) {
    const instanceId = entry.instanceId;
    await options.shutdownHandle(handle, entry.spec);
    if (entry.handle === handle) entry.handle = null;
    if (entry.instanceId === instanceId) entry.instanceId = null;
    return;
  }

  const pendingSpawn = entry.spawnPromise;
  if (!pendingSpawn) {
    return;
  }

  const spawnedHandle = await pendingSpawn.catch(() => null);
  if (spawnedHandle) {
    await options.shutdownHandle(spawnedHandle, entry.spec);
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

  await handle.close();
}

async function tryGracefulShutdown(
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
