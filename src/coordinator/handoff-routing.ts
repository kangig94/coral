import type { StrictBundleIdentityFailure, StrictBundleManifest } from '../infra/bundle-manifest.js';
import type {
  ForeignTargetValidator,
  InvalidTargetEvidence,
  TargetCandidateEvidence,
  ValidatedHandoffTarget,
} from '../infra/handoff-target.js';
import { compareProductVersions } from '../infra/product-version.js';

export type UnresolvedIncumbentCause = 'unreadable-record' | 'health-request-failed' | 'health-shape-rejected';

export type BuildSummary = Readonly<Pick<StrictBundleManifest, 'version' | 'buildSetId' | 'bundleHash' | 'flavor'>>;

export type IncumbentIdentitySummary = Readonly<{
  version: string;
  bundleHash: string;
  flavor: StrictBundleManifest['flavor'];
  namespace: string;
}>;

export type HandoffRoutingBasis =
  | Readonly<{ kind: 'incumbent-absent' }>
  | Readonly<{ kind: 'incumbent-unresolved'; cause: UnresolvedIncumbentCause }>
  | Readonly<{ kind: 'incumbent-unusable'; cause: 'draining' | 'identity-mismatch' }>
  | Readonly<{ kind: 'invoking-identity-unavailable'; failure: StrictBundleIdentityFailure }>
  | Readonly<{ kind: 'incumbent-identity-unavailable'; incumbent: IncumbentIdentitySummary }>
  | Readonly<{ kind: 'same-build-set'; buildSetId: string }>
  | Readonly<{
      kind: 'invoking-build-not-older';
      comparison: 'same-version' | 'newer-version';
      invoking: BuildSummary;
      incumbent: BuildSummary;
    }>
  | Readonly<{ kind: 'invalid-incumbent-target'; evidence: InvalidTargetEvidence }>;

export type HandoffRoutingResult =
  | Readonly<{ kind: 'continue-current'; basis: HandoffRoutingBasis }>
  | Readonly<{
      kind: 'handoff';
      target: ValidatedHandoffTarget;
      source: 'live-incumbent' | 'active-selection';
    }>;

export type LiveIncumbentRoutingInput = Readonly<{
  invokingManifest: StrictBundleManifest;
  incumbent: TargetCandidateEvidence;
  validateForeignTarget: ForeignTargetValidator;
}>;

function summarizeBuild(manifest: StrictBundleManifest): BuildSummary {
  return {
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
  };
}

export function routeLiveIncumbent(input: LiveIncumbentRoutingInput): HandoffRoutingResult {
  const { invokingManifest, incumbent, validateForeignTarget } = input;
  if (invokingManifest.buildSetId === incumbent.expectedManifest.buildSetId) {
    return {
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: invokingManifest.buildSetId },
    };
  }

  const precedence = compareProductVersions(invokingManifest.version, incumbent.expectedManifest.version);
  if (precedence >= 0) {
    return {
      kind: 'continue-current',
      basis: {
        kind: 'invoking-build-not-older',
        comparison: precedence === 0 ? 'same-version' : 'newer-version',
        invoking: summarizeBuild(invokingManifest),
        incumbent: summarizeBuild(incumbent.expectedManifest),
      },
    };
  }

  const validation = validateForeignTarget(incumbent.bundleDir, incumbent.expectedManifest);
  if (validation.kind === 'invalid') {
    return {
      kind: 'continue-current',
      basis: { kind: 'invalid-incumbent-target', evidence: validation.evidence },
    };
  }
  return { kind: 'handoff', target: validation.target, source: 'live-incumbent' };
}
