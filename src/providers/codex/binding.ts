import { z } from 'zod';

import type { ProfileBinding, ProviderBindingCodec } from '../contracts/binding.js';
import { absoluteProfilePathSchema } from '../contracts/profile.js';

export const codexSelectionSchema = z.object({ kind: z.literal('home'), home: absoluteProfilePathSchema }).strict();
export type CodexSelection = z.infer<typeof codexSelectionSchema>;

export const codexCredentialProfileSchema = z
  .object({
    canonicalLocation: absoluteProfilePathSchema,
    routing: z.object({ kind: z.literal('home') }).strict(),
  })
  .strict();
export type CodexCredentialProfile = z.infer<typeof codexCredentialProfileSchema>;

export const codexBindingSchema = z
  .object({ profile: codexCredentialProfileSchema, guarantee: z.literal('profile-only') })
  .strict();
export type CodexBinding = ProfileBinding<CodexCredentialProfile>;

export const codexBindingCodec: ProviderBindingCodec<CodexSelection, CodexCredentialProfile> = {
  selectionSchema: codexSelectionSchema,
  profileSchema: codexCredentialProfileSchema,
  bindingSchema: codexBindingSchema,
  bindingKind: 'profile',
  selectorLabel: () => 'Codex home',
  presentBinding: () => 'Codex credential profile',
};
