import { describe, expect, it } from 'vitest';
import type { ZodString } from 'zod';

import { buildSummarySchema, incumbentIdentitySummarySchema } from '#src/coordinator/handoff-routing.js';
import {
  durableHandoffRoutingBasisSchema,
  handoffRoutingTransitionSchema,
  invalidTargetSummarySchema,
  validatedTargetSummarySchema,
} from '#src/coordinator/handoff-routing-status.js';
import { liveIncumbentHealthSchema } from '#src/coordinator/handoff-runner.js';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';

function maximumLength(schema: ZodString): number {
  const maximum = schema.maxLength;
  expect(maximum).not.toBeNull();
  if (maximum === null) throw new Error('Expected a bounded producer schema.');
  return maximum;
}

function maximumVersion(schema: ZodString): string {
  const prefix = '1.0.0+';
  return `${prefix}${'x'.repeat(maximumLength(schema) - prefix.length)}`;
}

describe('handoff routing durable projections', () => {
  it('accepts the bundle manifest producer maximum in every manifest-derived projection', () => {
    const manifest = strictBundleManifestSchema.parse({
      version: maximumVersion(strictBundleManifestSchema.shape.version),
      buildSetId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      bundleHash: 'f'.repeat(16),
      cliBundleHash: 'f'.repeat(16),
      claudeAppserverBundleHash: 'f'.repeat(16),
      flavor: 'prod',
      storeFormatFingerprint: `sha256:${'f'.repeat(64)}`,
    });
    const build = {
      version: manifest.version,
      buildSetId: manifest.buildSetId,
      bundleHash: manifest.bundleHash,
      flavor: manifest.flavor,
    };

    expect(buildSummarySchema.safeParse(build).success).toBe(true);
    expect(validatedTargetSummarySchema.safeParse({ build }).success).toBe(true);
    expect(
      invalidTargetSummarySchema.safeParse({ failure: 'bundle-dir-unavailable', expectedBuild: build }).success,
    ).toBe(true);
    expect(
      durableHandoffRoutingBasisSchema.safeParse({
        kind: 'invoking-build-not-older',
        comparison: 'newer-version',
        invoking: build,
        incumbent: build,
      }).success,
    ).toBe(true);
    expect(
      handoffRoutingTransitionSchema.safeParse({
        kind: 'continuation-finalized',
        eventId: 'maximum-manifest-terminal',
        invocationId: 'maximum-manifest-invocation',
        observedAt: '2026-08-24T00:00:00.000Z',
        selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
        disposition: { kind: 'delegated-success', version: manifest.version },
      }).success,
    ).toBe(true);
  });

  it('accepts the live health ingress maximum in the incumbent identity projection', () => {
    const healthProducerSchema = liveIncumbentHealthSchema.innerType();
    const health = liveIncumbentHealthSchema.parse({
      status: 'ok',
      version: maximumVersion(healthProducerSchema.shape.version),
      bundleHash: 'f'.repeat(16),
      flavor: 'prod',
      namespace: 'handoff-routing-projection',
      instanceId: '\u0800'.repeat(maximumLength(healthProducerSchema.shape.instanceId)),
      pid: Number.MAX_SAFE_INTEGER,
    });
    const incumbent = {
      version: health.version,
      bundleHash: health.bundleHash,
      flavor: health.flavor,
      instanceId: health.instanceId,
    };

    expect(incumbentIdentitySummarySchema.safeParse(incumbent).success).toBe(true);
    expect(
      durableHandoffRoutingBasisSchema.safeParse({ kind: 'incumbent-identity-unavailable', incumbent }).success,
    ).toBe(true);
  });
});
