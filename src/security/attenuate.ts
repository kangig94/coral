import type { Capability } from './capability.js';
import type { Principal } from './principal.js';
import { capabilitiesFor } from './policy/capabilities.js';

export function attenuate(principal: Principal, caps: Iterable<Capability>): Principal {
  const requested = new Set(caps);
  const currentEffective = effectiveCapabilities(principal);
  const attenuatedCaps = new Set([...currentEffective].filter((capability) => requested.has(capability)));

  return {
    ...principal,
    attenuatedCaps,
  };
}

function effectiveCapabilities(principal: Principal): ReadonlySet<Capability> {
  const subjectCaps = capabilitiesFor(principal.subject);
  if (!principal.attenuatedCaps) {
    return subjectCaps;
  }

  return new Set([...subjectCaps].filter((capability) => principal.attenuatedCaps?.has(capability) ?? false));
}
