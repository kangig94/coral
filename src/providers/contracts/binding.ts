import { z } from 'zod';

import { nonEmptyStringSchema } from '../../infra/identifiers.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { ProviderPersistedParser, ProviderValueParser } from '../binding-parser-contract.js';

export type ProviderSelection = JsonValue;

export const providerSelectionEnvelopeSchema = z
  .object({ provider: nonEmptyStringSchema, selection: jsonValueSchema })
  .strict();
export type ProviderSelectionEnvelope = z.infer<typeof providerSelectionEnvelopeSchema>;

export interface ProviderSelectionCaptureContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

export type ProviderBindingRuntime = Pick<StoragePort, 'readFileSync' | 'realpathSync' | 'readdirSync' | 'statSync'>;

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

export const providerBindingFailureReasonSchema = z.enum([
  'missing-profile',
  'profile-unavailable',
  'identity-unavailable',
  'profile-mismatch',
  'subject-mismatch',
  'unsupported-selection',
  'invalid-persisted-binding',
]);
export type ProviderBindingFailureReason = z.infer<typeof providerBindingFailureReasonSchema>;

export type ProviderBindingFailure =
  | { readonly reason: 'missing-profile'; readonly provider: string }
  | { readonly reason: 'profile-unavailable'; readonly provider: string; readonly selector: string }
  | { readonly reason: 'identity-unavailable'; readonly provider: string }
  | { readonly reason: 'profile-mismatch'; readonly provider: string }
  | { readonly reason: 'subject-mismatch'; readonly provider: string }
  | { readonly reason: 'unsupported-selection'; readonly provider: string; readonly selector: string }
  | { readonly reason: 'invalid-persisted-binding'; readonly provider: string };

export type ProviderBindingResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: ProviderBindingFailure };

export type ProviderBindingUse = 'launch' | 'resume' | 'recovery';

export type ProviderReadiness = {
  readonly ready: true;
  readonly use: ProviderBindingUse;
};

export function bindingSuccess<Value>(value: Value): ProviderBindingResult<Value> {
  return Object.freeze({ ok: true, value });
}

export function bindingFailure<Value = never>(failure: ProviderBindingFailure): ProviderBindingResult<Value> {
  return Object.freeze({ ok: false, failure: Object.freeze(failure) });
}

/** Stable public error code for a typed provider-binding failure. */
export function providerBindingFailureCode(failure: ProviderBindingFailure): string {
  return `provider_binding_${failure.reason.replaceAll('-', '_')}`;
}

export class ProviderBindingRuntimeError extends Error {
  readonly failure: ProviderBindingFailure;

  constructor(failure: ProviderBindingFailure, message: string) {
    super(message);
    this.name = 'ProviderBindingRuntimeError';
    this.failure = failure;
  }
}

type ProviderBindingCodecBase<Selection extends JsonValue, Profile extends CredentialProfile & JsonValue> = {
  readonly parseSelection: ProviderValueParser<Selection>;
  readonly persistedProfile: ProviderPersistedParser<Profile>;
  readonly persistedContinuity: ProviderPersistedParser<Record<string, unknown>>;
  captureSelection(context: ProviderSelectionCaptureContext): ProviderBindingResult<Selection>;
  canonicalizeProfile(selection: Selection, runtime: ProviderBindingRuntime): Promise<ProviderBindingResult<Profile>>;
  selectorLabel(selection: Selection): string;
  renderFailure(failure: ProviderBindingFailure): string;
};

export type ProviderBindingCodec<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue = AccountSubject & JsonValue,
  Access extends JsonValue = JsonValue,
> = ProviderBindingCodecBase<Selection, Profile> &
  (
    | {
        readonly bindingKind: 'account';
        readonly persistedBinding: ProviderPersistedParser<ProviderBinding<Profile, Subject>>;
        bindProfile(
          profile: Profile,
          runtime: ProviderBindingRuntime,
        ): Promise<ProviderBindingResult<ProviderBinding<Profile, Subject>>>;
        readiness(
          binding: ProviderBinding<Profile, Subject>,
          use: ProviderBindingUse,
          runtime: ProviderBindingRuntime,
        ): Promise<ProviderBindingResult<ProviderReadiness>>;
        access(binding: ProviderBinding<Profile, Subject>): Access;
        compareBinding(
          left: ProviderBinding<Profile, Subject>,
          right: ProviderBinding<Profile, Subject>,
        ): ProviderBindingResult<true>;
        presentBinding(binding: ProviderBinding<Profile, Subject>): string;
      }
    | {
        readonly bindingKind: 'profile';
        readonly persistedBinding: ProviderPersistedParser<ProfileBinding<Profile>>;
        bindProfile(
          profile: Profile,
          runtime: ProviderBindingRuntime,
        ): Promise<ProviderBindingResult<ProfileBinding<Profile>>>;
        readiness(
          binding: ProfileBinding<Profile>,
          use: ProviderBindingUse,
          runtime: ProviderBindingRuntime,
        ): Promise<ProviderBindingResult<ProviderReadiness>>;
        access(binding: ProfileBinding<Profile>): Access;
        compareBinding(left: ProfileBinding<Profile>, right: ProfileBinding<Profile>): ProviderBindingResult<true>;
        presentBinding(binding: ProfileBinding<Profile>): string;
      }
  );
