import type { ProviderServerLease } from '../../../providers/contract.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';
import type { ProviderHostEntry, ProviderServerAttachment } from './state.js';

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
      if (entry.spec.leaseMode === 'shared') {
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

export function releaseProviderServerLease(entry: ProviderHostEntry): void {
  entry.leaseHeld = false;
}

export function activeLeaseCount(entry: ProviderHostEntry): number {
  if (entry.spec.leaseMode === 'shared') {
    return entry.sharedLeaseCount;
  }
  return entry.leaseHeld ? 1 : 0;
}
