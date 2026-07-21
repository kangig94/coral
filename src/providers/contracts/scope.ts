import { z } from 'zod';

import { nonEmptyStringSchema } from '../../infra/identifiers.js';
import { jsonValueSchema } from './json-value.js';

export const providerProfileEnvelopeSchema = z
  .object({ provider: nonEmptyStringSchema, profile: jsonValueSchema })
  .strict();
export type ProviderProfileEnvelope = z.infer<typeof providerProfileEnvelopeSchema>;

export const providerProfileSetSchema = z.array(providerProfileEnvelopeSchema).readonly();
export type ProviderProfileSet = z.infer<typeof providerProfileSetSchema>;

export const providerScopeSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('caller'), profiles: providerProfileSetSchema }).strict(),
  z.object({ origin: z.literal('system'), name: nonEmptyStringSchema, profiles: providerProfileSetSchema }).strict(),
]);
export type ProviderScope = z.infer<typeof providerScopeSchema>;
