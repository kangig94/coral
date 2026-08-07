import { describe, expect, it } from 'vitest';

import { providerRequestFailed, providerSessionUnavailable } from '#src/providers/fault.js';

describe('provider fault builders', () => {
  it('builds session.provider_failed causes for unavailable sessions', () => {
    const failureCause = providerSessionUnavailable({
      provider: 'codex',
      reason: 'thread missing',
    });

    expect(failureCause).toEqual({
      type: 'session.provider_failed',
      body: {
        provider: 'codex',
        reason: 'session_unavailable',
        message: 'thread missing',
      },
    });
  });

  it('builds session.provider_failed causes for failed requests', () => {
    const cause = new Error('upstream failed');
    const failureCause = providerRequestFailed({
      provider: 'claude',
      message: 'request failed',
      cause,
    });

    expect(failureCause).toEqual({
      type: 'session.provider_failed',
      body: {
        provider: 'claude',
        reason: 'request_failed',
        message: 'request failed',
      },
    });
  });
});
