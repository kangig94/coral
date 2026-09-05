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

export const providerBindingEnvelopeSchema = z
  .object({
    provider: z.string().min(1),
    kind: z.enum(['account', 'profile']),
    binding: durableJsonValueSchema,
  })
  .strict();

export type ProviderBindingEnvelope = z.infer<typeof providerBindingEnvelopeSchema>;
