import type { ProviderContinuityEventBody } from '../contract.js';

const CONTINUITY_COMMIT = Symbol('coral.provider-continuity-commit');

type ContinuityCommit = Readonly<{
  commit(): void;
  reject(error: unknown): void;
}>;

type ContinuityEventWithCommit = ProviderContinuityEventBody & {
  readonly [CONTINUITY_COMMIT]?: ContinuityCommit;
};

export function attachContinuityCommit(
  event: ProviderContinuityEventBody,
  commit: ContinuityCommit,
): ProviderContinuityEventBody {
  const attached = Object.create(Object.getPrototypeOf(event)) as ContinuityEventWithCommit;
  Object.defineProperties(attached, Object.getOwnPropertyDescriptors(event));
  Object.defineProperty(attached, CONTINUITY_COMMIT, {
    value: commit,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(attached);
}

export function forwardContinuityCommit(
  source: ProviderContinuityEventBody,
  snapshot: ProviderContinuityEventBody,
): ProviderContinuityEventBody {
  const commit = (source as ContinuityEventWithCommit)[CONTINUITY_COMMIT];
  return commit === undefined ? snapshot : attachContinuityCommit(snapshot, commit);
}

export function commitContinuityEvent(event: ProviderContinuityEventBody): void {
  (event as ContinuityEventWithCommit)[CONTINUITY_COMMIT]?.commit();
}

export function rejectContinuityEvent(event: ProviderContinuityEventBody, error: unknown): void {
  (event as ContinuityEventWithCommit)[CONTINUITY_COMMIT]?.reject(error);
}
