import { describe, expect, it } from 'vitest';

import { continuitySnapshotSchema } from '#src/sessions/continuity.js';
import { sessionContinuityMutationSchema } from '#src/sessions/continuity-mutation.js';

describe('continuity reference validation', () => {
  it('rejects empty continuity refs instead of treating them as absence or clear', () => {
    expect(
      continuitySnapshotSchema.safeParse({
        conversationRef: '',
        resumable: true,
        providerContinuity: null,
      }).success,
    ).toBe(false);
    expect(
      sessionContinuityMutationSchema.safeParse({
        kind: 'set_resumable',
        conversationRef: '',
      }).success,
    ).toBe(false);
  });
});
