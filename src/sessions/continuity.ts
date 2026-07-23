import { z } from 'zod';

import { nonEmptyStringSchema, readNonEmptyString } from '../infra/identifiers.js';

export const continuityRefSchema = nonEmptyStringSchema;

export const providerContinuityBlobSchema = z.record(z.string(), z.unknown());

export type ProviderContinuityBlob = z.infer<typeof providerContinuityBlobSchema>;

declare const PROVIDER_VALIDATED_CONTINUITY: unique symbol;

/** Provider-private continuity after decoding by the bound provider capability. */
export type ProviderValidatedContinuityBlob = ProviderContinuityBlob & {
  readonly [PROVIDER_VALIDATED_CONTINUITY]: true;
};

export const continuitySnapshotSchema = z
  .object({
    conversationRef: continuityRefSchema.nullable(),
    resumable: z.boolean(),
    providerContinuity: providerContinuityBlobSchema.nullable(),
  })
  .strict();

export type ContinuitySnapshot = z.infer<typeof continuitySnapshotSchema>;

export type ProviderValidatedContinuitySnapshot = Omit<ContinuitySnapshot, 'providerContinuity'> & {
  providerContinuity: ProviderValidatedContinuityBlob | null;
};

export function readContinuityRef(value: string | null | undefined): string | undefined {
  return readNonEmptyString(value);
}
