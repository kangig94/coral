import { z } from 'zod';

import type { ProfileBinding, ProviderBindingCodec } from '../contracts/binding.js';
import { absoluteProfilePathSchema } from '../contracts/profile.js';

export const claudeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('config-dir'), configDir: absoluteProfilePathSchema }).strict(),
  z.object({ kind: z.literal('ambient') }).strict(),
]);
export type ClaudeSelection = z.infer<typeof claudeSelectionSchema>;

export const claudeCredentialProfileSchema = z
  .object({
    canonicalLocation: absoluteProfilePathSchema,
    routing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(true) }).strict(),
      z.object({ kind: z.literal('ambient'), emitConfigDir: z.literal(false) }).strict(),
    ]),
  })
  .strict();
export type ClaudeCredentialProfile = z.infer<typeof claudeCredentialProfileSchema>;

export const claudeBindingSchema = z
  .object({ profile: claudeCredentialProfileSchema, guarantee: z.literal('profile-only') })
  .strict();
export type ClaudeBinding = ProfileBinding<ClaudeCredentialProfile>;

export const claudeBindingCodec: ProviderBindingCodec<ClaudeSelection, ClaudeCredentialProfile> = {
  selectionSchema: claudeSelectionSchema,
  profileSchema: claudeCredentialProfileSchema,
  bindingSchema: claudeBindingSchema,
  bindingKind: 'profile',
  selectorLabel(selection) {
    return selection.kind === 'ambient' ? 'caller-default Claude profile' : 'Claude config directory';
  },
  presentBinding: () => 'Claude credential profile',
};
