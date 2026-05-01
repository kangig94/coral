import { describe, expect, it } from 'vitest';

import { codexRecoveryLifecycle } from '#src/providers/codex/provider-facets.js';

describe('codexRecoveryLifecycle.finalizeInterrupted', () => {
  it('uses the preserved conversation ref when the session is resumable without a parsed thread id', () => {
    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          cwd: '/workspace',
        },
      },
      {
        cwd: '/workspace',
      },
      { preservedConversationRef: 'ref-x' },
    );

    expect(mutation).toEqual({
      type: 'set_resumable',
      conversationRef: 'ref-x',
      providerContinuity: {
        cwd: '/workspace',
      },
    });
  });

  it('preserves continuity when the session is resumable but there is no effective conversation ref to write', () => {
    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          cwd: '/workspace',
        },
      },
      {
        cwd: '/workspace',
      },
      {},
    );

    expect(mutation).toEqual({
      type: 'preserve',
      providerContinuity: {
        cwd: '/workspace',
      },
    });
  });
});
