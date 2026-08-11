import { z } from 'zod';

import type { ProviderEventBody } from './contract.js';
import type { ProviderFailureCause } from './fault.js';

export const PROVIDER_PROXY_FAILURE_ORIGIN = '@coral/provider-proxy' as const;
export const MAX_PROVIDER_PROXY_EMERGENCY_FRAME_BYTES = 641;

export const providerProxyReplayFailureReasonSchema = z.enum([
  'provider_replay_operation_events_exhausted',
  'provider_replay_operation_bytes_exhausted',
  'provider_replay_proxy_bytes_exhausted',
  'provider_completion_too_large',
]);

export type ProviderProxyReplayFailureReason = z.output<typeof providerProxyReplayFailureReasonSchema>;

export const providerProxyReplayFailureInputSchema = z
  .object({ reason: providerProxyReplayFailureReasonSchema })
  .strict();

export const providerProxyFailureMessages = {
  provider_replay_operation_events_exhausted: 'Replay event count reached 4,096 for this operation.',
  provider_replay_operation_bytes_exhausted: 'Replay bytes reached 16,777,216 for this operation.',
  provider_replay_proxy_bytes_exhausted: 'Shared replay bytes reached 58,720,256 for this proxy.',
  provider_completion_too_large: 'The provider completion could not fit its replay allocation.',
} as const;

export const providerProxyFailureCauseSchema = z
  .object({
    type: z.literal('session.provider_failed'),
    body: z
      .object({
        provider: z.literal(PROVIDER_PROXY_FAILURE_ORIGIN),
        reason: z.literal('request_failed'),
        message: z.union([
          z.literal(providerProxyFailureMessages.provider_replay_operation_events_exhausted),
          z.literal(providerProxyFailureMessages.provider_replay_operation_bytes_exhausted),
          z.literal(providerProxyFailureMessages.provider_replay_proxy_bytes_exhausted),
          z.literal(providerProxyFailureMessages.provider_completion_too_large),
        ]),
      })
      .strict(),
  })
  .strict();

export type ProviderProxyFailureCause = z.output<typeof providerProxyFailureCauseSchema>;

export function providerProxyReplayFailed(input: unknown): ProviderProxyFailureCause {
  const { reason } = providerProxyReplayFailureInputSchema.parse(input);
  return providerProxyFailureCauseSchema.parse({
    type: 'session.provider_failed',
    body: {
      provider: PROVIDER_PROXY_FAILURE_ORIGIN,
      reason: 'request_failed',
      message: providerProxyFailureMessages[reason],
    },
  });
}

export function isProviderProxyFailureOrigin(provider: string): provider is typeof PROVIDER_PROXY_FAILURE_ORIGIN {
  return provider === PROVIDER_PROXY_FAILURE_ORIGIN;
}

export function isProviderProxyFailureCause(cause: ProviderFailureCause): cause is ProviderProxyFailureCause {
  return cause.type === 'session.provider_failed' && isProviderProxyFailureOrigin(cause.body.provider);
}

export const providerProxyEmergencyEventSchema = z
  .object({
    kind: z.literal('terminal'),
    terminal: z
      .object({
        content: z.literal(''),
        outcome: z.object({ kind: z.literal('failed') }).strict(),
        durationMs: z.literal(0),
      })
      .strict(),
    diagnostics: z.object({}).strict(),
    failureCause: providerProxyFailureCauseSchema,
  })
  .strict();

export type ProviderProxyEmergencyEvent = z.output<typeof providerProxyEmergencyEventSchema>;

export function providerProxyEmergencyEvent(input: unknown): ProviderProxyEmergencyEvent {
  const failureCause = providerProxyReplayFailed(input);
  const event = {
    kind: 'terminal',
    terminal: { content: '', outcome: { kind: 'failed' }, durationMs: 0 },
    diagnostics: {},
    failureCause,
  } satisfies ProviderEventBody;
  return providerProxyEmergencyEventSchema.parse(event);
}
