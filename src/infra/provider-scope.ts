import { z } from 'zod';

import { nonEmptyStringSchema } from './identifiers.js';
import { jsonValueSchema } from './json-value.js';

export const providerProfileEnvelopeSchema = z
  .object({ provider: nonEmptyStringSchema, profile: jsonValueSchema })
  .strict();
export type ProviderProfileEnvelope = z.infer<typeof providerProfileEnvelopeSchema>;

export const providerProfileSetSchema = z.array(providerProfileEnvelopeSchema).readonly();
export type ProviderProfileSet = z.infer<typeof providerProfileSetSchema>;

export const callerProviderScopeSchema = z
  .object({ origin: z.literal('caller'), profiles: providerProfileSetSchema })
  .strict();
export const systemProviderScopeSchema = z
  .object({ origin: z.literal('system'), name: nonEmptyStringSchema, profiles: providerProfileSetSchema })
  .strict();
export const providerScopeSchema = z.discriminatedUnion('origin', [
  callerProviderScopeSchema,
  systemProviderScopeSchema,
]);
export type ProviderScope = z.infer<typeof providerScopeSchema>;
export type CallerProviderScope = z.infer<typeof callerProviderScopeSchema>;
export type SystemProviderScope = z.infer<typeof systemProviderScopeSchema>;
