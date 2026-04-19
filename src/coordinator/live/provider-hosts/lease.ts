import type { ProviderServerLease } from '../../../providers/types.js';
import type { ProviderServerHandle } from '../durable-transport.js';
import type { ProviderHostEntry, ProviderServerAttachment, ProviderServerWaiter } from './pool.js';

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function createProviderServerLease(
  handle: ProviderServerHandle,
  entry: ProviderHostEntry,
  releaseSharedLease: (entry: ProviderHostEntry) => void,
  releaseExclusiveLease: (entry: ProviderHostEntry) => void,
): ProviderServerLease {
  let released = false;
  return {
    rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
    subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
      handle.onNotification(handler),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (entry.spec.shared === true) {
        releaseSharedLease(entry);
        return;
      }
      releaseExclusiveLease(entry);
    },
    closed: handle.closePromise,
    generation: handle.generation,
  };
}

export function createProviderServerAttachment(handle: ProviderServerHandle): ProviderServerAttachment {
  return {
    rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
    subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
      handle.onNotification(handler),
    closed: handle.closePromise,
  };
}

export async function waitForProviderServerLease(entry: ProviderHostEntry, signal?: AbortSignal): Promise<void> {
  if (entry.closingError) {
    throw entry.closingError;
  }
  if (!entry.leaseHeld) {
    entry.leaseHeld = true;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      waiter.cleanup();
      callback();
    };

    const waiter: ProviderServerWaiter = {
      resolve: () => finish(resolve),
      reject: (error: Error) => finish(() => reject(error)),
      cleanup: () => {
        signal?.removeEventListener('abort', onAbort);
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) {
          entry.waiters.splice(index, 1);
        }
      },
    };

    const onAbort = () => {
      waiter.reject(createAbortError('Aborted while waiting for a provider server lease'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    entry.waiters.push(waiter);
  });
}

export function acquireSharedProviderServerLease(entry: ProviderHostEntry): void {
  entry.sharedLeaseCount += 1;
}

export function releaseSharedProviderServerLease(
  entry: ProviderHostEntry,
  maybeArmIdleTimer: (entry: ProviderHostEntry) => void,
): void {
  if (entry.sharedLeaseCount === 0) {
    return;
  }
  entry.sharedLeaseCount -= 1;
  maybeArmIdleTimer(entry);
}

export function releaseProviderServerLease(
  entry: ProviderHostEntry,
  maybeArmIdleTimer: (entry: ProviderHostEntry) => void,
): void {
  const next = entry.waiters.shift();
  if (next) {
    next.resolve();
    return;
  }
  entry.leaseHeld = false;
  maybeArmIdleTimer(entry);
}

export function activeLeaseCount(entry: ProviderHostEntry): number {
  if (entry.spec.shared === true) {
    return entry.sharedLeaseCount;
  }
  return entry.leaseHeld ? 1 : 0;
}
