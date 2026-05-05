import { z } from 'zod';

import {
  continuityRefSchema,
  providerContinuityBlobSchema,
  type ProviderContinuityBlob,
} from '../sessions/continuity.js';

export interface JobContinuitySnapshot {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity?: ProviderContinuityBlob;
}

export const jobContinuitySnapshotSchema = z
  .object({
    conversationRef: continuityRefSchema.nullable(),
    resumable: z.boolean(),
    providerContinuity: providerContinuityBlobSchema.optional(),
  })
  .strict();
