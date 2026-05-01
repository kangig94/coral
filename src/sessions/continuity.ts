import { z } from 'zod';

export const providerContinuityBlobSchema = z.record(z.unknown());

export type ProviderContinuityBlob = z.infer<typeof providerContinuityBlobSchema>;

export const continuitySnapshotSchema = z
  .object({
    conversationRef: z.string().nullable(),
    resumable: z.boolean(),
    providerContinuity: providerContinuityBlobSchema.nullable(),
  })
  .strict();

export type ContinuitySnapshot = z.infer<typeof continuitySnapshotSchema>;
