import { z } from 'zod';

import { nonEmptyStringSchema, readNonEmptyString } from '../infra/identifiers.js';

export const continuityRefSchema = nonEmptyStringSchema;

export const providerContinuityBlobSchema = z.record(z.string(), z.unknown());

export type ProviderContinuityBlob = z.infer<typeof providerContinuityBlobSchema>;

export const continuitySnapshotSchema = z
  .object({
    conversationRef: continuityRefSchema.nullable(),
    resumable: z.boolean(),
    providerContinuity: providerContinuityBlobSchema.nullable(),
  })
  .strict();

export type ContinuitySnapshot = z.infer<typeof continuitySnapshotSchema>;

export function readContinuityRef(value: string | null | undefined): string | undefined {
  return readNonEmptyString(value);
}
