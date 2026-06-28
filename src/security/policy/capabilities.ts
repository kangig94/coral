import type { Subject } from '../principal.js';
import type { Capability } from '../capability.js';

const SUBJECT_CAPABILITY_LISTS = {
  operator: [
    'liveness',
    'kb:read',
    'kb:write',
    'kb:source:import',
    'jobs:read',
    'jobs:control',
    'discuss:participate',
    'expansion:manage',
    'system:shutdown',
    'system:debug',
  ],
  agent: ['liveness', 'kb:read', 'jobs:read', 'discuss:participate'],
  system: [
    'liveness',
    'kb:read',
    'kb:write',
    'kb:source:import',
    'jobs:read',
    'jobs:control',
    'discuss:participate',
    'expansion:manage',
    'system:debug',
  ],
} as const satisfies Record<Subject, readonly Capability[]>;

const SUBJECT_CAPABILITIES: Readonly<Record<Subject, ReadonlySet<Capability>>> = {
  operator: new Set(SUBJECT_CAPABILITY_LISTS.operator),
  agent: new Set(SUBJECT_CAPABILITY_LISTS.agent),
  system: new Set(SUBJECT_CAPABILITY_LISTS.system),
};

export function capabilitiesFor(subject: Subject): ReadonlySet<Capability> {
  return SUBJECT_CAPABILITIES[subject];
}
