import { describe, expect, it } from 'vitest';

import { claudeRecoveryLifecycle } from '#src/providers/claude/provider-facets.js';

describe('claudeRecoveryLifecycle.finalizeInterrupted', () => {
  it('uses the preserved conversation ref when the session is resumable without a bootstrap signature', () => {
    const mutation = claudeRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          brokerSessionKey: 'broker-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
      },
      { preservedConversationRef: 'ref-x' },
    );

    expect(mutation).toEqual({
      kind: 'set_resumable',
      conversationRef: 'ref-x',
    });
  });

  it('preserves continuity when the session is resumable but there is no effective conversation ref to write', () => {
    const mutation = claudeRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          brokerSessionKey: 'broker-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
      },
      {},
    );

    expect(mutation).toEqual({
      kind: 'preserve',
    });
  });
});
