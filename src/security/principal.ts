import type { Capability } from './capability.js';

export type Subject = 'operator' | 'agent' | 'system';

export type Credential = {
  readonly kind: string;
  readonly id: string;
};

export type ResourceBinding = { readonly kind: 'unbound' } | { readonly kind: 'project'; readonly root: string };

export type Principal = {
  readonly subject: Subject;
  readonly transport: string;
  readonly credential: Credential;
  readonly binding: ResourceBinding;
  readonly attenuatedCaps?: ReadonlySet<Capability>;
};
