import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeLiveIncumbent, type BackendRoutingResult } from '#src/infra/backend-routing.js';
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
  const bundleDir = mkdtempSync(join(tmpdir(), 'coral-backend-routing-'));
  roots.push(bundleDir);
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(expectedManifest), 'utf8');
  return { bundleDir, expectedManifest };
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

describe('backend-routing', () => {
  it('should use the live incumbent for an exact build set without validation', () => {
    const invoking = manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate({ ...invoking, version: '9.0.0' });

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }),
    ).toEqual({
      kind: 'use-current',
      evidence: { source: 'live-incumbent' },
    });
  });

  it('should hand an older invocation to a validated newer incumbent', async () => {
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

  it('should keep an older incumbent when the invocation is newer', () => {
    const invoking = manifest('3.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'));

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }).kind,
    ).toBe('use-current');
  });

  it('should keep the incumbent for equal semantic versions with different builds', () => {
    const invoking = manifest('2.0.0+invoking', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0+incumbent', '223e4567-e89b-42d3-a456-426614174000'));

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: validatorThatMustNotRun(),
      }).kind,
    ).toBe('use-current');
  });

  it('should keep a healthy live incumbent when its newer handoff target is invalid', () => {
    const invoking = manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000');
    const incumbent = candidate(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'));
    const invalid: InvalidTargetEvidence = {
      bundleDir: incumbent.bundleDir,
      expectedManifest: incumbent.expectedManifest,
      failure: 'adjacent-bundle-mismatch',
    };

    expect(
      routeLiveIncumbent({
        invokingManifest: invoking,
        incumbent,
        validateForeignTarget: () => ({ kind: 'invalid', evidence: invalid }),
      }),
    ).toEqual({
      kind: 'use-current',
      evidence: { source: 'live-incumbent' },
    });
  });

  it('should represent a cold invalid newer target with the sole reset arm', () => {
    const invalid: InvalidTargetEvidence = {
      bundleDir: '/canonical/foreign-bundle',
      expectedManifest: manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'),
      failure: 'adjacent-manifest-unavailable',
    };

    const routing = {
      kind: 'reset-newer-invalid',
      evidence: invalid,
    } satisfies BackendRoutingResult;

    expect(routing).toEqual({ kind: 'reset-newer-invalid', evidence: invalid });
  });
});
