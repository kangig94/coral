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

  if (!bindingSatisfies(principal, requestedBinding, requires)) {
    return {
      ok: false,
      reason: 'resource_unbound',
      detail: { requires, requestedBinding, principalBinding: principal.binding, subject: principal.subject },
    };
  }

  return { ok: true };
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
  const bound = normalizeProjectRoot(boundRoot);
  const requested = normalizeProjectRoot(requestedRoot);
  return requested === bound || requested.startsWith(`${bound}/`);
}

function normalizeProjectRoot(root: string): string {
  const usesAbsolutePrefix = root.startsWith('/') || root.startsWith('\\');
  const parts: string[] = [];

  for (const part of root.replace(/\\/gu, '/').split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }

    if (part === '..') {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  const normalized = parts.join('/');
  return usesAbsolutePrefix ? `/${normalized}` : normalized;
}
