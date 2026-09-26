import type { Capability } from './capability.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';

export type Subject = 'operator' | 'agent' | 'system';

export type Credential = {
  readonly kind: string;
  readonly id: string;
};

export type ResourceBinding =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'project'; readonly root: CanonicalWorkDir };

/** What a request asks to act on. No project owns the KB Corpus, so a `corpus` request is decided by capability
 *  alone and a principal's project binding cannot narrow it; a principal is never bound to `corpus`. */
export type RequestedBinding = ResourceBinding | { readonly kind: 'corpus' };

export type Principal = {
  readonly subject: Subject;
  readonly transport: string;
  readonly credential: Credential;
  readonly binding: ResourceBinding;
  readonly attenuatedCaps?: ReadonlySet<Capability>;
};
