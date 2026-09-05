import { z } from 'zod';

import type { JsonValue } from './json-value.js';

const durableJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(durableJsonValueSchema),
    z.record(durableJsonValueSchema),
  ]),
);

export const providerProfileEnvelopeSchema = z
  .object({ provider: z.string().min(1), profile: durableJsonValueSchema })
  .strict();
export type ProviderProfileEnvelope = z.infer<typeof providerProfileEnvelopeSchema>;

export const providerProfileSetSchema = z.array(providerProfileEnvelopeSchema).readonly();
export type ProviderProfileSet = z.infer<typeof providerProfileSetSchema>;

export const callerProviderScopeSchema = z
  .object({ origin: z.literal('caller'), profiles: providerProfileSetSchema })
  .strict();
export const systemProviderScopeSchema = z
  .object({ origin: z.literal('system'), name: z.string().min(1), profiles: providerProfileSetSchema })
  .strict();
export const providerScopeSchema = z.discriminatedUnion('origin', [
  callerProviderScopeSchema,
  systemProviderScopeSchema,
]);
export type ProviderScope = z.infer<typeof providerScopeSchema>;
export type SystemProviderScope = z.infer<typeof systemProviderScopeSchema>;
