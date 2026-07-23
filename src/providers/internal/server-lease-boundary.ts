import type { AppServerSession, AppServerTransport, ProviderRuntime } from '../contract.js';
import { snapshotBoundaryData, snapshotProviderResult } from './snapshot.js';

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

export function wrapAppServerTransport(session: AppServerTransport, label: string): AppServerTransport {
  if (session === null || typeof session !== 'object') throw new TypeError(`${label} must be an object.`);
  const rpc = dataMember(session, 'rpc', label);
  const subscribe = dataMember(session, 'subscribe', label);
  const closed = dataMember(session, 'closed', label);
  if (typeof rpc !== 'function' || typeof subscribe !== 'function') {
    throw new TypeError(`${label} must expose rpc and subscribe data methods.`);
  }
  if (!(closed instanceof Promise)) throw new TypeError(`${label}.closed must be a Promise.`);
  return Object.freeze({
    rpc: async <R = unknown>(method: string, params: Record<string, unknown>): Promise<R> => {
      const result = await rpc.call(session, method, snapshotBoundaryData(params, `${label} RPC parameters`));
      return snapshotProviderResult(result, `${label} RPC result`) as R;
    },
    subscribe: (handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
      const unsubscribe = subscribe.call(session, (message: unknown) => {
        handler(
          snapshotBoundaryData(message, `${label} notification`) as {
            method: string;
            params?: Record<string, unknown>;
          },
        );
      }) as unknown;
      if (typeof unsubscribe !== 'function') {
        throw new TypeError(`${label}.subscribe must return an unsubscribe function.`);
      }
      return () => unsubscribe.call(undefined);
    },
    closed: closed.then((result) => result),
  });
}

export function wrapAppServerSession(session: AppServerSession, label: string): AppServerSession {
  const transport = wrapAppServerTransport(session, label);
  const interrupt = dataMember(session, 'interrupt', label);
  if (typeof interrupt !== 'function') throw new TypeError(`${label} must expose an interrupt data method.`);
  return Object.freeze({
    ...transport,
    interrupt: (continuity: NonNullable<ProviderRuntime['persistedContinuity']>) =>
      Promise.resolve(
        interrupt.call(session, snapshotBoundaryData(continuity, `${label} interrupt continuity`)) as unknown,
      ).then((acted) => {
        if (typeof acted !== 'boolean') throw new TypeError(`${label}.interrupt must resolve to a boolean.`);
        return acted;
      }),
  });
}
