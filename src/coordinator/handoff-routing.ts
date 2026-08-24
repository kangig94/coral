import { z } from 'zod';

import {
  strictBundleManifestSchema,
  type StrictBundleIdentityFailure,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import type {
  ForeignTargetValidator,
  InvalidTargetEvidence,
  TargetCandidateEvidence,
  ValidatedHandoffTarget,
} from '../infra/handoff-target.js';
import { compareProductVersions } from '../infra/product-version.js';

export type UnresolvedIncumbentCause = 'unreadable-record' | 'health-request-failed' | 'health-shape-rejected';

export const buildSummarySchema = strictBundleManifestSchema
  .pick({ version: true, buildSetId: true, bundleHash: true, flavor: true })
  .readonly();

export type BuildSummary = z.infer<typeof buildSummarySchema>;

export const incumbentIdentitySummarySchema = z
  .object({
    version: strictBundleManifestSchema.shape.version,
    bundleHash: strictBundleManifestSchema.shape.bundleHash,
    flavor: strictBundleManifestSchema.shape.flavor,
    instanceId: z.string().min(1).max(64),
  })
  .strict()
  .readonly()
  .brand<'IncumbentIdentitySummary'>();

export type IncumbentIdentitySummary = z.infer<typeof incumbentIdentitySummarySchema>;

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

export type RoutingBasisObligation = Readonly<{
  requiredDurability: 'durable-status-required' | 'ephemeral-allowed';
  requiredRetention: 'until-superseded' | 'bounded-history';
  severity: 'info' | 'warning';
  exitContribution: 0 | 75;
}>;

export const HANDOFF_ROUTING_BASIS_OBLIGATIONS: Readonly<Record<HandoffRoutingBasis['kind'], RoutingBasisObligation>> =
  {
    'incumbent-absent': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'until-superseded',
      severity: 'info',
      exitContribution: 0,
    },
    'incumbent-unresolved': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
    'incumbent-unusable': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
    'invoking-identity-unavailable': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
    'incumbent-identity-unavailable': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
    'same-build-set': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'until-superseded',
      severity: 'info',
      exitContribution: 0,
    },
    'invoking-build-not-older': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
    'invalid-incumbent-target': {
      requiredDurability: 'durable-status-required',
      requiredRetention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
  };

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
  return buildSummarySchema.parse({
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
  });
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
