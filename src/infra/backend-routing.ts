import type { StrictBundleManifest } from './bundle-manifest.js';
import type {
  ForeignTargetValidator,
  InvalidTargetEvidence,
  TargetCandidateEvidence,
  ValidatedHandoffTarget,
} from './handoff-target.js';
import { compareProductVersions } from './product-version.js';

export type UseCurrentEvidence = { readonly source: 'current-build' } | { readonly source: 'live-incumbent' };

export type BackendRoutingResult =
  | { readonly kind: 'use-current'; readonly evidence: UseCurrentEvidence }
  | {
      readonly kind: 'handoff';
      readonly target: ValidatedHandoffTarget;
      readonly source: 'live-incumbent' | 'active-selection';
    }
  | { readonly kind: 'reset-newer-invalid'; readonly evidence: InvalidTargetEvidence };

export type LiveIncumbentRoutingInput = Readonly<{
  invokingManifest: StrictBundleManifest;
  incumbent: TargetCandidateEvidence;
  validateForeignTarget: ForeignTargetValidator;
}>;

export function createUseCurrentBackendRouting(evidence: UseCurrentEvidence): BackendRoutingResult {
  return { kind: 'use-current', evidence };
}

function useLiveIncumbent(): BackendRoutingResult {
  return createUseCurrentBackendRouting({ source: 'live-incumbent' });
}

export function routeLiveIncumbent(input: LiveIncumbentRoutingInput): BackendRoutingResult {
  const { invokingManifest, incumbent, validateForeignTarget } = input;
  if (invokingManifest.buildSetId === incumbent.expectedManifest.buildSetId) {
    return useLiveIncumbent();
  }

  const precedence = compareProductVersions(invokingManifest.version, incumbent.expectedManifest.version);
  if (precedence >= 0) {
    return useLiveIncumbent();
  }

  const validation = validateForeignTarget(incumbent.bundleDir, incumbent.expectedManifest);
  if (validation.kind === 'invalid') {
    return useLiveIncumbent();
  }
  return { kind: 'handoff', target: validation.target, source: 'live-incumbent' };
}
