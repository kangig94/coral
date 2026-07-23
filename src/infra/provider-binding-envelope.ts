import { z } from 'zod';

import { nonEmptyStringSchema } from './identifiers.js';
import { jsonValueSchema } from './json-value.js';

export const providerBindingEnvelopeSchema = z
  .object({
    provider: nonEmptyStringSchema,
    kind: z.enum(['account', 'profile']),
    binding: jsonValueSchema,
  })
  .strict();

export type ProviderBindingEnvelope = z.infer<typeof providerBindingEnvelopeSchema>;
