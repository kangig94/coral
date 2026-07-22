import type { ProviderServerLease, ProviderServerSpec } from '../contract.js';
import { snapshotBoundaryData, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';

function dataMember(receiver: object, key: string, label: string): unknown {
  let cursor: object | null = receiver;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`${label}.${key} must be a data property.`);
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}

const wrappedServerLeases = new WeakMap<object, ProviderServerLease>();

export function wrapServerLease(lease: ProviderServerLease, label: string): ProviderServerLease {
  if (lease === null || typeof lease !== 'object') throw new TypeError(`${label} must be an object.`);
  const existing = wrappedServerLeases.get(lease);
  if (existing !== undefined) return existing;
  const rpc = dataMember(lease, 'rpc', label);
  const subscribe = dataMember(lease, 'subscribe', label);
  const release = dataMember(lease, 'release', label);
  const closed = dataMember(lease, 'closed', label);
  const generation = dataMember(lease, 'generation', label);
  if (typeof rpc !== 'function' || typeof subscribe !== 'function' || typeof release !== 'function') {
    throw new TypeError(`${label} must expose rpc, subscribe, and release data methods.`);
  }
  if (!(closed instanceof Promise)) throw new TypeError(`${label}.closed must be a Promise.`);
  if (generation !== undefined && typeof generation !== 'number') {
    throw new TypeError(`${label}.generation must be a number when present.`);
  }
  const wrapped = Object.freeze({
    rpc: async <R = unknown>(method: string, params: Record<string, unknown>): Promise<R> => {
      const result = await rpc.call(lease, method, snapshotBoundaryData(params, `${label} RPC parameters`));
      return snapshotProviderResult(result, `${label} RPC result`) as R;
    },
    subscribe: (handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
      const unsubscribe = subscribe.call(lease, (message: unknown) => {
        handler(
          snapshotBoundaryData(message, `${label} notification`) as {
            method: string;
            params?: Record<string, unknown>;
          },
        );
      }) as unknown;
      if (typeof unsubscribe !== 'function')
        throw new TypeError(`${label}.subscribe must return an unsubscribe function.`);
      return () => {
        unsubscribe.call(undefined);
      };
    },
    release: () => release.call(lease),
    closed: closed.then((result) => result),
    ...(generation === undefined ? {} : { generation: snapshotBoundaryData(generation, `${label} generation`) }),
  });
  wrappedServerLeases.set(lease, wrapped);
  wrappedServerLeases.set(wrapped, wrapped);
  return wrapped;
}

export function wrapAcquireServer(
  receiver: object,
  acquireServer: (spec: ProviderServerSpec, options?: { signal?: AbortSignal }) => Promise<ProviderServerLease>,
  label: string,
): (spec: ProviderServerSpec, options?: { signal?: AbortSignal }) => Promise<ProviderServerLease> {
  return async (spec, options) => {
    const canonicalSpec = snapshotBoundaryData(spec, `${label} specification`);
    const canonicalOptions =
      options === undefined
        ? undefined
        : (snapshotPlainReceiver(options, `${label} options`, new Set(['signal'])) as typeof options);
    const lease = await acquireServer.call(receiver, canonicalSpec, canonicalOptions);
    return wrapServerLease(lease, `${label} lease`);
  };
}
