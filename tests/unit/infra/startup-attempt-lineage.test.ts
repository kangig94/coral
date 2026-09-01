import { describe, expect, it } from 'vitest';

import {
  resolveStartupAttemptLineage,
  startupAttemptIdentityMatches,
} from '../../../src/infra/startup-attempt-lineage.js';

describe('startup attempt lineage', () => {
  it('resolves startup lineage as proven current, proven other, or unknown', () => {
    const desiredIdentity = {
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      namespace: 'test-namespace',
    };

    expect(
      resolveStartupAttemptLineage({
        observedAttemptId: 'current-attempt',
        expectedAttemptId: 'current-attempt',
        desiredIdentity,
      }),
    ).toMatchObject({ kind: 'proven-current-attempt', proof: 'startup-attempt-id' });
    expect(
      resolveStartupAttemptLineage({
        observedAttemptId: 'other-attempt',
        expectedAttemptId: 'current-attempt',
        observedIdentity: desiredIdentity,
        desiredIdentity,
      }),
    ).toEqual({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
    expect(
      resolveStartupAttemptLineage({
        observedAttemptId: 'other-attempt',
        expectedAttemptId: 'current-attempt',
        desiredIdentity,
      }),
    ).toEqual({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
    expect(resolveStartupAttemptLineage({ desiredIdentity })).toEqual({ kind: 'unknown' });
  });

  it('does not let an attempt id that is not an identifier prove or exclude this attempt', () => {
    const desiredIdentity = {
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      namespace: 'test-namespace',
    };
    const otherIdentity = { ...desiredIdentity, bundleHash: 'other-hash' };

    for (const nonIdentifier of ['', '   ']) {
      expect(
        resolveStartupAttemptLineage({
          observedAttemptId: nonIdentifier,
          expectedAttemptId: nonIdentifier,
          observedIdentity: otherIdentity,
          desiredIdentity,
        }),
      ).toEqual({ kind: 'unknown' });
      expect(
        resolveStartupAttemptLineage({
          observedAttemptId: nonIdentifier,
          expectedAttemptId: 'current-attempt',
          observedIdentity: otherIdentity,
          desiredIdentity,
        }),
      ).toEqual({ kind: 'unknown' });
      expect(
        resolveStartupAttemptLineage({
          observedAttemptId: 'other-attempt',
          expectedAttemptId: nonIdentifier,
          observedIdentity: otherIdentity,
          desiredIdentity,
        }),
      ).toEqual({ kind: 'unknown' });
    }

    // An unusable attempt id must not block the identity proof, only decline to add to it.
    expect(
      resolveStartupAttemptLineage({
        observedAttemptId: '',
        expectedAttemptId: '',
        observedIdentity: desiredIdentity,
        desiredIdentity,
      }),
    ).toMatchObject({ kind: 'proven-current-attempt', proof: 'desired-identity' });
  });

  it('does not prove lineage from an identity that cannot state its namespace', () => {
    const observedIdentity = {
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      namespace: 'observed-namespace',
    };

    expect(
      resolveStartupAttemptLineage({
        observedIdentity,
        // A canonical startup identity must state the namespace that owns its coordinator address.
        // @ts-expect-error Intentionally exercise a non-canonical caller at the runtime boundary.
        desiredIdentity: {
          version: observedIdentity.version,
          bundleHash: observedIdentity.bundleHash,
          flavor: observedIdentity.flavor,
        },
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('matches desired startup identity independently of attempt lineage', () => {
    const desiredIdentity = {
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      namespace: 'test-namespace',
    };

    expect(startupAttemptIdentityMatches(desiredIdentity, desiredIdentity)).toBe(true);
    expect(startupAttemptIdentityMatches({ ...desiredIdentity, bundleHash: 'different-hash' }, desiredIdentity)).toBe(
      false,
    );
  });
});
