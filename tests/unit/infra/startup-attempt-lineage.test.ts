import { describe, expect, it } from 'vitest';

import { resolveStartupAttemptLineage } from '../../../src/infra/startup-attempt-lineage.js';

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
    ).toMatchObject({ kind: 'proven-current-attempt', proof: 'desired-identity' });
    expect(
      resolveStartupAttemptLineage({
        observedAttemptId: 'other-attempt',
        expectedAttemptId: 'current-attempt',
        desiredIdentity,
      }),
    ).toEqual({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
    expect(resolveStartupAttemptLineage({ desiredIdentity })).toEqual({ kind: 'unknown' });
  });
});
