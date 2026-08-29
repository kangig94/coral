import { z } from 'zod';

import { operationIdentitySchema } from '../../provider-proxy/protocol.js';
import type { ProviderOperationIdentity } from '../../store/provider-operation-record.js';
import { providerProxySetIdentitySchema, type ProviderProxySetIdentity } from './provider-proxy-set/identity.js';

export type ProviderRepresentationAbandonmentNotice = Readonly<{
  operation: ProviderOperationIdentity;
  setIdentity: ProviderProxySetIdentity;
}>;

export type ProviderRepresentationAbandonmentAcceptance = Readonly<{
  kind: 'accepted';
  operation: ProviderOperationIdentity;
  disposition: 'record-absent' | 'local-recovery-committed' | 'terminalization-committed' | 'settlement-deleted';
}>;

export type RepresentationAbandonmentDeliveryAttemptOutcome =
  | Readonly<{
      kind: 'accepted';
      acceptance: ProviderRepresentationAbandonmentAcceptance;
    }>
  | Readonly<{
      kind: 'operational-failure';
      code: 'representation_abandonment_consumer_unavailable';
      reason: string;
    }>;

export interface ProviderRepresentationAbandonmentConsumer {
  representationAbandoned(
    notice: ProviderRepresentationAbandonmentNotice,
  ): Promise<RepresentationAbandonmentDeliveryAttemptOutcome>;
}

export const providerRepresentationAbandonmentNoticeSchema = z
  .object({
    operation: operationIdentitySchema,
    setIdentity: providerProxySetIdentitySchema,
  })
  .strict();

const providerRepresentationAbandonmentAcceptanceSchema = z
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

export const representationAbandonmentDeliveryAttemptOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('accepted'),
      acceptance: providerRepresentationAbandonmentAcceptanceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operational-failure'),
      code: z.literal('representation_abandonment_consumer_unavailable'),
      reason: z.string().min(1),
    })
    .strict(),
]);
