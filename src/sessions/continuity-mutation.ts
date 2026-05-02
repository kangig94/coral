import { z } from 'zod';

import { providerContinuityBlobSchema } from './continuity.js';

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
export type SessionContinuityMutation = z.infer<typeof sessionContinuityMutationSchema>;
