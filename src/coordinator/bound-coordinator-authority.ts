import type { SuccessfulCoordinatorBindResult } from './handoff.js';

declare const boundCoordinatorAuthorityBrand: unique symbol;

export interface BoundCoordinatorAuthority {
  readonly [boundCoordinatorAuthorityBrand]: true;
}

const authorityByBindResult = new WeakMap<object, BoundCoordinatorAuthority>();

export function boundCoordinatorAuthorityFrom(bindResult: SuccessfulCoordinatorBindResult): BoundCoordinatorAuthority {
  const existing = authorityByBindResult.get(bindResult);
  if (existing !== undefined) {
    return existing;
  }

  const authority = Object.freeze({}) as BoundCoordinatorAuthority;
  authorityByBindResult.set(bindResult, authority);
  return authority;
}
