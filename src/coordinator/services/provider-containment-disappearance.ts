import { z } from 'zod';

import { operationIdentitySchema } from '../../provider-proxy/protocol.js';
import type { ProviderOperationIdentity } from '../../store/provider-operation-record.js';
import { providerProxySetIdentitySchema, type ProviderProxySetIdentity } from './provider-proxy-set-identity.js';

export type ContainmentDisappearanceNotice = Readonly<{
  operation: ProviderOperationIdentity;
  setIdentity: ProviderProxySetIdentity;
  disappearanceReceipt: string;
}>;

export type ContainmentDisappearanceAcceptance = Readonly<{
  kind: 'accepted';
  operation: ProviderOperationIdentity;
  disposition: 'record-absent' | 'local-recovery-committed' | 'terminalization-committed' | 'settlement-deleted';
}>;

export type DisappearanceDeliveryAttemptOutcome =
  | Readonly<{
      kind: 'accepted';
      acceptance: ContainmentDisappearanceAcceptance;
    }>
  | Readonly<{
      kind: 'operational-failure';
      code: 'disappearance_consumer_unavailable';
      reason: string;
    }>;

export interface ProviderContainmentDisappearanceConsumer {
  containmentDisappeared(notice: ContainmentDisappearanceNotice): Promise<DisappearanceDeliveryAttemptOutcome>;
}

export const containmentDisappearanceNoticeSchema = z
  .object({
    operation: operationIdentitySchema,
    setIdentity: providerProxySetIdentitySchema,
    disappearanceReceipt: z.string().min(1).max(4096),
  })
  .strict();

export const containmentDisappearanceAcceptanceSchema = z
  .object({
    kind: z.literal('accepted'),
    operation: operationIdentitySchema,
    disposition: z.enum([
      'record-absent',
      'local-recovery-committed',
      'terminalization-committed',
      'settlement-deleted',
    ]),
  })
  .strict();

export const disappearanceDeliveryAttemptOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('accepted'),
      acceptance: containmentDisappearanceAcceptanceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operational-failure'),
      code: z.literal('disappearance_consumer_unavailable'),
      reason: z.string().min(1),
    })
    .strict(),
]);
