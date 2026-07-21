import { z } from 'zod';

import type { ProviderBindingCodec } from '#src/providers/contracts/binding.js';

const selectionSchema = z.object({ key: z.string() }).strict();
const profileSchema = z.object({ canonicalLocation: z.string(), routing: z.object({}).strict() }).strict();
const bindingSchema = z.object({ profile: profileSchema, guarantee: z.literal('profile-only') }).strict();

export function fixtureProviderBindingCodec(
  provider: string,
): ProviderBindingCodec<z.infer<typeof selectionSchema>, z.infer<typeof profileSchema>> {
  return {
    selectionSchema,
    profileSchema,
    bindingSchema,
    bindingKind: 'profile',
    selectorLabel: () => `${provider} fixture selector`,
    presentBinding: () => `${provider} fixture profile`,
  };
}
