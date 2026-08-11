import { describe, expect, it } from 'vitest';

import { providerFailureCauseSchema, providerTerminalEventBodySchema } from '#src/providers/contract.js';
import {
  PROVIDER_PROXY_FAILURE_ORIGIN,
  isProviderProxyFailureCause,
  isProviderProxyFailureOrigin,
  providerProxyEmergencyEvent,
  providerProxyEmergencyEventSchema,
  providerProxyFailureCauseSchema,
  providerProxyFailureMessages,
  providerProxyReplayFailed,
  providerProxyReplayFailureReasonSchema,
} from '#src/providers/proxy-failure.js';
import { persistedProviderNameSchema } from '#src/providers/registry.js';

const REASONS = providerProxyReplayFailureReasonSchema.options;

describe('provider proxy replay failures', () => {
  it('builds exactly the four closed causes and terminal events accepted by the ordinary provider schemas', () => {
    expect(REASONS).toHaveLength(4);
    for (const reason of REASONS) {
      const cause = providerProxyReplayFailed({ reason });
      const event = providerProxyEmergencyEvent({ reason });

      expect(cause).toEqual({
        type: 'session.provider_failed',
        body: {
          provider: PROVIDER_PROXY_FAILURE_ORIGIN,
          reason: 'request_failed',
          message: providerProxyFailureMessages[reason],
        },
      });
      expect(providerProxyFailureCauseSchema.parse(cause)).toEqual(cause);
      expect(providerFailureCauseSchema.parse(cause)).toEqual(cause);
      expect(providerProxyEmergencyEventSchema.parse(event)).toEqual(event);
      expect(providerTerminalEventBodySchema.parse(event)).toEqual(event);
    }
  });

  it('rejects a fifth reason and every caller override', () => {
    expect(() => providerProxyReplayFailed({ reason: 'provider_replay_other_exhausted' })).toThrow();
    expect(() =>
      providerProxyReplayFailed({
        reason: 'provider_replay_operation_events_exhausted',
        provider: 'codex',
      }),
    ).toThrow();
    expect(() =>
      providerProxyEmergencyEvent({
        reason: 'provider_replay_operation_events_exhausted',
        diagnostics: { warnings: ['caller supplied'] },
      }),
    ).toThrow();
  });

  it('classifies origin by the registry-impossible sentinel, never by presentation text', () => {
    expect(persistedProviderNameSchema.safeParse(PROVIDER_PROXY_FAILURE_ORIGIN).success).toBe(false);
    expect(isProviderProxyFailureOrigin(PROVIDER_PROXY_FAILURE_ORIGIN)).toBe(true);
    expect(isProviderProxyFailureOrigin('codex')).toBe(false);

    const sameMessage = providerProxyFailureMessages.provider_replay_proxy_bytes_exhausted;
    expect(
      isProviderProxyFailureCause({
        type: 'session.provider_failed',
        body: {
          provider: PROVIDER_PROXY_FAILURE_ORIGIN,
          reason: 'request_failed',
          message: 'presentation text changed',
        },
      }),
    ).toBe(true);
    expect(
      isProviderProxyFailureCause({
        type: 'session.provider_failed',
        body: { provider: 'codex', reason: 'request_failed', message: sameMessage },
      }),
    ).toBe(false);
  });
});
