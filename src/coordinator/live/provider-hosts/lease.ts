import type { AppServerTransport } from '../../../providers/contract.js';
import type { ProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { PinToken, ProviderHostEntry, ProviderHostPin } from './state.js';

export function createProviderServerLease(handle: ProviderServerHandle, releasePin: () => void): ProviderServerLease {
  return {
    rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
    subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
      handle.onNotification(handler),
    release: releasePin,
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

export function acquireProviderHostPin(
  entry: ProviderHostEntry,
  pin: ProviderHostPin,
  onLastRelease: () => void,
): () => void {
  const token: PinToken = Symbol(pin.kind);
  entry.pins.set(token, pin);
  return () => {
    if (!entry.pins.delete(token)) return;
    if (entry.pins.size === 0) onLastRelease();
  };
}

export function activePinCount(entry: ProviderHostEntry): number {
  return entry.pins.size;
}
export interface ProviderServerLease extends AppServerTransport {
  release(): void;
  generation: number;
}
