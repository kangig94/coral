import { z } from 'zod';

import { nonEmptyStringSchema } from '../../infra/identifiers.js';
import { jsonValueSchema, type JsonValue } from './json-value.js';

export type ProviderSelection = JsonValue;

export type CredentialProfile<Routing extends JsonValue = JsonValue> = {
  readonly canonicalLocation: string;
  readonly routing: Routing;
};

export const accountSubjectSchema = z.object({ issuer: nonEmptyStringSchema, subject: nonEmptyStringSchema }).strict();
export type AccountSubject = z.infer<typeof accountSubjectSchema>;

export type ProviderBinding<Profile, Subject = AccountSubject> = {
  readonly profile: Profile;
  readonly subject: Subject;
};

export type ProfileBinding<Profile> = {
  readonly profile: Profile;
  readonly guarantee: 'profile-only';
};

export const providerBindingEnvelopeSchema = z
  .object({
    provider: nonEmptyStringSchema,
    kind: z.enum(['account', 'profile']),
    binding: jsonValueSchema,
  })
  .strict();
export type ProviderBindingEnvelope = z.infer<typeof providerBindingEnvelopeSchema>;

export type ProviderBindingFailure =
  | { readonly reason: 'missing-profile'; readonly provider: string }
  | { readonly reason: 'profile-unavailable'; readonly provider: string; readonly selector: string }
  | { readonly reason: 'identity-unavailable'; readonly provider: string }
  | { readonly reason: 'subject-mismatch'; readonly provider: string }
  | { readonly reason: 'unsupported-selection'; readonly provider: string; readonly selector: string }
  | { readonly reason: 'invalid-persisted-binding'; readonly provider: string };

type ProviderBindingCodecBase<Selection extends JsonValue, Profile extends CredentialProfile & JsonValue> = {
  readonly selectionSchema: z.ZodType<Selection>;
  readonly profileSchema: z.ZodType<Profile>;
  selectorLabel(selection: Selection): string;
};

export type ProviderBindingCodec<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue = AccountSubject & JsonValue,
> = ProviderBindingCodecBase<Selection, Profile> &
  (
    | {
        readonly bindingKind: 'account';
        readonly bindingSchema: z.ZodType<ProviderBinding<Profile, Subject>>;
        presentBinding(binding: ProviderBinding<Profile, Subject>): string;
      }
    | {
        readonly bindingKind: 'profile';
        readonly bindingSchema: z.ZodType<ProfileBinding<Profile>>;
        presentBinding(binding: ProfileBinding<Profile>): string;
      }
  );
