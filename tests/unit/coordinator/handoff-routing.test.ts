import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ROUTING_BASIS_OBLIGATIONS, routeLiveIncumbent } from '#src/coordinator/handoff-routing.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ForeignTargetValidator,
  type InvalidTargetEvidence,
  type TargetCandidateEvidence,
} from '#src/infra/handoff-target.js';

const roots: string[] = [];
const backendBundle = 'routing backend';
const cliBundle = 'routing cli';
const claudeAppserverBundle = 'routing claude appserver';

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
    cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
  };
}

function candidate(expectedManifest: StrictBundleManifest): TargetCandidateEvidence {
  const bundleDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-'));
  roots.push(bundleDir);
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(expectedManifest), 'utf8');
  return { bundleDir, expectedManifest };
}

function summarize(build: StrictBundleManifest) {
  return {
    version: build.version,
    buildSetId: build.buildSetId,
    bundleHash: build.bundleHash,
    flavor: build.flavor,
  };
}

function validatorThatMustNotRun(): ForeignTargetValidator {
  return vi.fn(() => {
    throw new Error('validator should not run');
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff routing', () => {
  it('binds every routing basis to its durability, retention, severity, and exit obligation', () => {
    expect(HANDOFF_ROUTING_BASIS_OBLIGATIONS).toEqual({
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
    });
  });

  it('produces same-build-set for an exact build set without validation', () => {
    const invoking = manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate({ ...invoking, version: '9.0.0' });

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }),
    ).toEqual({
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: invoking.buildSetId },
    });
  });

  it('produces invoking-build-not-older with newer-version summaries', () => {
    const invoking = manifest('3.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'));

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }),
    ).toEqual({
      kind: 'continue-current',
      basis: {
        kind: 'invoking-build-not-older',
        comparison: 'newer-version',
        invoking: summarize(invoking),
        incumbent: summarize(incumbent.expectedManifest),
      },
    });
  });

  it('produces invoking-build-not-older with same-version summaries for build metadata differences', () => {
    const invoking = manifest('2.0.0+invoking', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0+incumbent', '223e4567-e89b-42d3-a456-426614174000'));

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }),
    ).toEqual({
      kind: 'continue-current',
      basis: {
        kind: 'invoking-build-not-older',
        comparison: 'same-version',
        invoking: summarize(invoking),
        incumbent: summarize(incumbent.expectedManifest),
      },
    });
  });

  it('produces invalid-incumbent-target with the validator evidence', () => {
    const invoking = manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'));
    const evidence: InvalidTargetEvidence = {
      bundleDir: incumbent.bundleDir,
      expectedManifest: incumbent.expectedManifest,
      failure: 'adjacent-bundle-mismatch',
    };

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: () => ({ kind: 'invalid', evidence }),
      }),
    ).toEqual({
      kind: 'continue-current',
      basis: { kind: 'invalid-incumbent-target', evidence },
    });
  });

  it('produces the live-incumbent source for a validated newer incumbent', () => {
    const invoking = manifest('1.9.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'));
    const result = routeLiveIncumbent({
      invokingManifest: invoking,
      incumbent,
      validateForeignTarget: createForeignTargetValidator(),
    });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.source).toBe('live-incumbent');
    withValidatedHandoffTarget(result.target).assertExecutable();
  });
});
