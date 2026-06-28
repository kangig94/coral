export const CAPABILITIES = [
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityScope = 'bound-project' | 'any';

export type CapabilityRegistryEntry = {
  readonly capability: Capability;
  readonly scope: CapabilityScope;
};

export const CAPABILITY_REGISTRY = {
  liveness: { capability: 'liveness', scope: 'any' },
  'kb:read': { capability: 'kb:read', scope: 'bound-project' },
  'kb:write': { capability: 'kb:write', scope: 'bound-project' },
  'kb:source:import': { capability: 'kb:source:import', scope: 'bound-project' },
  'jobs:read': { capability: 'jobs:read', scope: 'bound-project' },
  'jobs:control': { capability: 'jobs:control', scope: 'bound-project' },
  'discuss:participate': { capability: 'discuss:participate', scope: 'bound-project' },
  'expansion:manage': { capability: 'expansion:manage', scope: 'any' },
  'system:shutdown': { capability: 'system:shutdown', scope: 'any' },
  'system:debug': { capability: 'system:debug', scope: 'any' },
} as const satisfies Record<Capability, CapabilityRegistryEntry>;

const CAPABILITY_SET: ReadonlySet<Capability> = new Set(CAPABILITIES);

export const ALL_CAPABILITIES: ReadonlySet<Capability> = CAPABILITY_SET;

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value as Capability);
}

export function capabilityScope(capability: Capability): CapabilityScope {
  return CAPABILITY_REGISTRY[capability].scope;
}
