import { z } from 'zod';

import type { JsonValue } from './json-value.js';
import { persistedNonEmptyStringSchema } from './persisted-scalar-contracts.js';

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

export const providerBindingEnvelopeSchema = z
  .object({
    provider: persistedNonEmptyStringSchema,
    kind: z.enum(['account', 'profile']),
    binding: durableJsonValueSchema,
  })
  .strict();

export type ProviderBindingEnvelope = z.infer<typeof providerBindingEnvelopeSchema>;
