import { z } from 'zod';

import { providerContinuityBlobSchema, type ProviderContinuityBlob } from '../sessions/continuity.js';

export interface JobContinuitySnapshot {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity?: ProviderContinuityBlob;
}

export const jobContinuitySnapshotSchema = z
  .object({
    conversationRef: z.string().nullable(),
    resumable: z.boolean(),
    providerContinuity: providerContinuityBlobSchema.optional(),
  })
  .strict();
