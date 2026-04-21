import { z } from 'zod';

import { providerContinuityBlobSchema, type ProviderContinuityBlob } from '../sessions/continuity.js';

/**
 * Authoritative provider->session continuity contract.
 */
export type SessionContinuityMutation =
  | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
  | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
  | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob };

export const sessionContinuityMutationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('set_resumable'),
      conversationRef: z.string(),
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('clear_non_resumable'),
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preserve'),
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
]);
