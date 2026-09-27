import { throwIfAborted } from '../runtime/abort.js';

export type DurableRequestIdentity = Readonly<{ jobId?: string; operationId?: string }>;

const identities = new WeakMap<AbortSignal, DurableRequestIdentity>();
const owners = new WeakMap<AbortSignal, AbortSignal>();

export function linkRequestLeaseIdentity(signal: AbortSignal, owner: AbortSignal): void {
  owners.set(signal, owner);
}

export function identifyDurableRequest(signal: AbortSignal | undefined, identity: DurableRequestIdentity): void {
  if (signal === undefined) return;
  identities.set(signal, identity);
  const owner = owners.get(signal);
  if (owner !== undefined) identities.set(owner, identity);
}

export function durableRequestIdentity(signal: AbortSignal): DurableRequestIdentity | undefined {
  return identities.get(signal);
}

export function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined) throwIfAborted(signal, 'request-before-durable-acceptance');
}
