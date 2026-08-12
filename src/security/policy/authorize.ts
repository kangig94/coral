import { isAbsolute, relative } from 'node:path';

import { ALL_CAPABILITIES, capabilityScope, type Capability } from '../capability.js';
import type { Principal, ResourceBinding } from '../principal.js';
import { capabilitiesFor } from './capabilities.js';

export type AuthorizationFailureReason = 'missing_capability' | 'resource_unbound' | 'unauthenticated';

export type AuthorizationFailureDetail = {
  readonly requires: Capability;
  readonly requestedBinding: ResourceBinding;
  readonly principalBinding?: ResourceBinding;
  readonly subject?: Principal['subject'];
};

export type Decision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AuthorizationFailureReason;
      readonly detail: AuthorizationFailureDetail;
    };

export function authorize(
  principal: Principal | null | undefined,
  requires: Capability,
  requestedBinding: ResourceBinding,
): Decision {
  const capabilityDecision = authorizeCapability(principal, requires, requestedBinding);
  if (!capabilityDecision.ok) return capabilityDecision;
  if (!principal) throw new Error('Capability authorization accepted a missing principal.');

  return authorizeResourceBinding(principal, requires, requestedBinding);
}

export function authorizeCapability(
  principal: Principal | null | undefined,
  requires: Capability,
  requestedBinding: ResourceBinding = { kind: 'unbound' },
): Decision {
  if (!principal) {
    return {
      ok: false,
      reason: 'unauthenticated',
      detail: { requires, requestedBinding },
    };
  }

  if (!hasEffectiveCapability(principal, requires)) {
    return {
      ok: false,
      reason: 'missing_capability',
      detail: { requires, requestedBinding, principalBinding: principal.binding, subject: principal.subject },
    };
  }
  return { ok: true };
}

export function authorizeResourceBinding(
  principal: Principal,
  requires: Capability,
  requestedBinding: ResourceBinding,
): Decision {
  return bindingSatisfies(principal, requestedBinding, requires)
    ? { ok: true }
    : {
        ok: false,
        reason: 'resource_unbound',
        detail: { requires, requestedBinding, principalBinding: principal.binding, subject: principal.subject },
      };
}

function hasEffectiveCapability(principal: Principal, requires: Capability): boolean {
  if (!capabilitiesFor(principal.subject).has(requires)) {
    return false;
  }

  return (principal.attenuatedCaps ?? ALL_CAPABILITIES).has(requires);
}

function bindingSatisfies(principal: Principal, requestedBinding: ResourceBinding, requires: Capability): boolean {
  if (capabilityScope(requires) === 'any') {
    return true;
  }

  const principalBinding = principal.binding;
  if (principalBinding.kind === 'unbound') {
    return principal.subject === 'operator' || principal.subject === 'system';
  }

  if (requestedBinding.kind === 'unbound') {
    return false;
  }

  return containsProjectRoot(principalBinding.root, requestedBinding.root);
}

function containsProjectRoot(boundRoot: string, requestedRoot: string): boolean {
  const descendant = relative(boundRoot, requestedRoot);
  return descendant === '' || (!descendant.startsWith('..') && !isAbsolute(descendant));
}
