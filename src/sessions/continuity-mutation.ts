import { z } from 'zod';

import { continuityRefSchema, providerContinuityBlobSchema } from './continuity.js';

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
