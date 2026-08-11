import type { AppServerTransport } from '../../../providers/contract.js';
import type { ProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { ProviderHostEntry } from './state.js';

export function createProviderServerLease(handle: ProviderServerHandle, releasePin: () => void): ProviderServerLease {
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
      releasePin();
    },
    closed: handle.closePromise,
    generation: handle.generation,
  };
}

export function createProviderServerAttachment(handle: ProviderServerHandle): AppServerTransport {
  return {
    rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
    subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
      handle.onNotification(handler),
    closed: handle.closePromise,
  };
}

export function acquireProviderHostPin(entry: ProviderHostEntry): void {
  entry.pinCount += 1;
}

export function releaseProviderHostPin(entry: ProviderHostEntry): void {
  if (entry.pinCount === 0) {
    throw new Error(`Provider host '${entry.hostKey}' pin count underflow.`);
  }
  entry.pinCount -= 1;
}

export function activePinCount(entry: ProviderHostEntry): number {
  return entry.pinCount;
}
export interface ProviderServerLease extends AppServerTransport {
  release(): void;
  generation: number;
}
