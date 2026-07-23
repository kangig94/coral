import { z } from 'zod';

import { continuityRefSchema, providerContinuityBlobSchema } from './continuity.js';
import type { ProviderValidatedContinuityBlob } from './continuity.js';

export const sessionContinuityMutationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('set_resumable'),
      conversationRef: continuityRefSchema,
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('clear_non_resumable'),
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('preserve'),
      providerContinuity: providerContinuityBlobSchema.optional(),
    })
    .strict(),
]);
export type SessionContinuityMutation = z.infer<typeof sessionContinuityMutationSchema>;

/** Recovery mutation whose provider-private blob, when present, came from the bound provider codec. */
export type ProviderValidatedSessionContinuityMutation =
  | {
      kind: 'set_resumable';
      conversationRef: string;
      providerContinuity?: ProviderValidatedContinuityBlob;
    }
  | { kind: 'clear_non_resumable'; providerContinuity?: ProviderValidatedContinuityBlob }
  | { kind: 'preserve'; providerContinuity?: ProviderValidatedContinuityBlob };
