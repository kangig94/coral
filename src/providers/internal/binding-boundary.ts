import {
  bindingFailure,
  bindingSuccess,
  providerSelectionEnvelopeSchema,
  type AccountSubject,
  type CredentialProfile,
  type ProviderBindingCodec,
  type ProviderBindingFailure,
  type ProviderBindingResult,
  type ProviderBindingRuntime,
  type ProviderBindingUse,
  type ProviderSelectionCaptureContext,
  type ProviderSelectionEnvelope,
} from '../contracts/binding.js';
import type { ProviderArtifactCapability, ProviderImplementation } from '../contract.js';
import type { BoundProvider } from '../bound-provider-contract.js';
import type { ProviderValueParser } from '../binding-parser-contract.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { providerBindingEnvelopeSchema, type ProviderBindingEnvelope } from '../../infra/provider-binding-envelope.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';
import { providerProfileEnvelopeSchema, type ProviderProfileEnvelope } from '../../infra/provider-scope.js';
import type { CanonicalContractValue } from '../../store/format-fingerprint.js';
import { rehydrateCodecBinding, type CapturedBoundCodec } from './bound-provider.js';
import { snapshotBoundaryData, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';

export interface ErasedProviderBindingBoundary {
  readonly provider: string;
  readonly bindingContract: CanonicalContractValue;
  readonly bindingKind: 'account' | 'profile';
  captureSelection(context: ProviderSelectionCaptureContext): ProviderBindingResult<ProviderSelectionEnvelope>;
  canonicalizeProfile(
    envelope: ProviderSelectionEnvelope,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderProfileEnvelope>>;
  bindProfile(
    envelope: ProviderProfileEnvelope,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<BoundProvider>>;
  selectorLabel(rawSelection: unknown): string;
  decode(envelope: ProviderBindingEnvelope): ProviderBindingResult<BoundProvider>;
  parseProfile(rawProfile: unknown): ProviderBindingResult<ProviderProfileEnvelope>;
  renderFailure(failure: ProviderBindingFailure): string;
}

interface CapturedBindingAuthority<Profile extends CredentialProfile & JsonValue, Source extends JsonValue> {
  readonly selectionParser: ProviderValueParser<JsonValue>;
  readonly profileParser: ProviderValueParser<Profile>;
  readonly bindingParser: ProviderValueParser<unknown>;
  readonly bindingContract: CanonicalContractValue;
  readonly bindingKind: 'account' | 'profile';
  readonly boundCodec: CapturedBoundCodec<Source>;
  captureSelection(context: ProviderSelectionCaptureContext): ProviderBindingResult<JsonValue>;
  canonicalizeProfile(selection: JsonValue, runtime: ProviderBindingRuntime): Promise<ProviderBindingResult<Profile>>;
  bindProfile(profile: Profile, runtime: ProviderBindingRuntime): Promise<ProviderBindingResult<unknown>>;
  selectorLabel(selection: JsonValue): string;
  renderFailure(failure: ProviderBindingFailure): string;
}

function captureBindingAuthority<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue,
  Source extends JsonValue,
>(codec: ProviderBindingCodec<Selection, Profile, Subject, Source>): CapturedBindingAuthority<Profile, Source> {
  const receiver = snapshotPlainReceiver(codec, 'Provider binding codec');
  const captureSelection = receiver.captureSelection;
  const canonicalizeProfile = receiver.canonicalizeProfile;
  const bindProfile = receiver.bindProfile;
  const selectorLabel = receiver.selectorLabel;
  const renderFailure = receiver.renderFailure;
  const invokeBindProfile = bindProfile as (
    profile: Profile,
    runtime: ProviderBindingRuntime,
  ) => Promise<ProviderBindingResult<unknown>>;
  return Object.freeze({
    selectionParser: receiver.parseSelection,
    profileParser: receiver.parseProfile,
    bindingParser: receiver.persistedBinding.parse,
    bindingContract: snapshotBoundaryData(receiver.persistedBinding.contract, 'Provider persisted binding contract'),
    bindingKind: receiver.bindingKind,
    boundCodec: captureBoundCodec(receiver),
    captureSelection: (context: ProviderSelectionCaptureContext) => captureSelection.call(receiver, context),
    canonicalizeProfile: (selection: JsonValue, runtime: ProviderBindingRuntime) =>
      canonicalizeProfile.call(receiver, selection as Selection, runtime),
    bindProfile: (profile: Profile, runtime: ProviderBindingRuntime) =>
      invokeBindProfile.call(receiver, profile, runtime),
    selectorLabel: (selection: JsonValue) => selectorLabel.call(receiver, selection as Selection),
    renderFailure: (failure: ProviderBindingFailure) => renderFailure.call(receiver, failure),
  });
}

function captureBoundCodec<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue,
  Source extends JsonValue,
>(receiver: ProviderBindingCodec<Selection, Profile, Subject, Source>): CapturedBoundCodec<Source> {
  const { bindingKind, presentBinding, credentialSource, readiness, compareBinding } = receiver;
  const bindingParser = receiver.persistedBinding.parse;
  return Object.freeze({
    bindingKind,
    parseBinding: (binding: unknown) => bindingParser(binding),
    presentBinding: (binding: unknown) => presentBinding.call(receiver, binding as never),
    credentialSource: (binding: unknown) => credentialSource.call(receiver, binding as never),
    readiness: (binding: unknown, use: ProviderBindingUse, runtime: ProviderBindingRuntime) =>
      readiness
        .call(receiver, binding as never, use, runtime)
        .then((result) => snapshotProviderResult(result, 'Provider codec readiness result')),
    compareBinding: (left: unknown, right: unknown) =>
      snapshotProviderResult(
        compareBinding.call(receiver, left as never, right as never),
        'Provider codec identity comparison result',
      ),
  });
}

function decodeCodecBinding<
  Plan extends ProviderExecutionPlan,
  Profile extends CredentialProfile & JsonValue,
  Source extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  implementation: ProviderImplementation<Plan, Source>,
  artifacts: ProviderArtifactCapability<Source>,
  rawBinding: unknown,
): ProviderBindingResult<BoundProvider> {
  const binding = authority.bindingParser(snapshotBoundaryData(rawBinding, 'Provider binding parser input'));
  return binding.success
    ? bindingSuccess(rehydrateCodecBinding(provider, authority.boundCodec, binding.data, implementation, artifacts))
    : bindingFailure({ reason: 'invalid-persisted-binding', provider });
}

function captureBoundarySelection<Profile extends CredentialProfile & JsonValue, Source extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  context: ProviderSelectionCaptureContext,
): ProviderBindingResult<ProviderSelectionEnvelope> {
  const captured = snapshotProviderResult(
    authority.captureSelection(snapshotBoundaryData(context, 'Provider selection capture context')),
    'Provider selection capture result',
  );
  return captured.ok
    ? bindingSuccess(
        snapshotBoundaryData(
          { provider, selection: jsonValueSchema.parse(captured.value) },
          'Provider selection envelope',
        ),
      )
    : captured;
}

async function canonicalizeBoundaryProfile<Profile extends CredentialProfile & JsonValue, Source extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  rawEnvelope: ProviderSelectionEnvelope,
  runtime: ProviderBindingRuntime,
): Promise<ProviderBindingResult<ProviderProfileEnvelope>> {
  const envelope = providerSelectionEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success || envelope.data.provider !== provider) {
    return bindingFailure({ reason: 'unsupported-selection', provider, selector: `${provider} selection` });
  }
  const selection = authority.selectionParser(
    snapshotBoundaryData(envelope.data.selection, 'Provider selection parser input'),
  );
  if (!selection.success) {
    return bindingFailure({ reason: 'unsupported-selection', provider, selector: `${provider} selection` });
  }
  const canonicalSelection = snapshotBoundaryData(jsonValueSchema.parse(selection.data), 'Provider selection');
  const profile = snapshotProviderResult(
    await authority.canonicalizeProfile(canonicalSelection, runtime),
    'Provider profile canonicalization result',
  );
  return profile.ok
    ? bindingSuccess(
        snapshotBoundaryData({ provider, profile: jsonValueSchema.parse(profile.value) }, 'Provider profile envelope'),
      )
    : profile;
}

async function bindBoundaryProfile<
  Plan extends ProviderExecutionPlan,
  Profile extends CredentialProfile & JsonValue,
  Source extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  implementation: ProviderImplementation<Plan, Source>,
  artifacts: ProviderArtifactCapability<Source>,
  rawEnvelope: ProviderProfileEnvelope,
  runtime: ProviderBindingRuntime,
): Promise<ProviderBindingResult<BoundProvider>> {
  const envelope = providerProfileEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success || envelope.data.provider !== provider)
    return bindingFailure({ reason: 'missing-profile', provider });
  const profile = authority.profileParser(snapshotBoundaryData(envelope.data.profile, 'Provider profile parser input'));
  if (!profile.success) {
    return bindingFailure({ reason: 'profile-unavailable', provider, selector: `${provider} credential profile` });
  }
  const canonicalProfile = snapshotBoundaryData(jsonValueSchema.parse(profile.data), 'Provider profile') as Profile;
  const binding = snapshotProviderResult(
    await authority.bindProfile(canonicalProfile, runtime),
    'Provider profile binding result',
  );
  return binding.ok ? decodeCodecBinding(provider, authority, implementation, artifacts, binding.value) : binding;
}

function decodeBoundaryEnvelope<
  Plan extends ProviderExecutionPlan,
  Profile extends CredentialProfile & JsonValue,
  Source extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  implementation: ProviderImplementation<Plan, Source>,
  artifacts: ProviderArtifactCapability<Source>,
  rawEnvelope: ProviderBindingEnvelope,
): ProviderBindingResult<BoundProvider> {
  const envelope = providerBindingEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success || envelope.data.provider !== provider || envelope.data.kind !== authority.bindingKind) {
    return bindingFailure({ reason: 'invalid-persisted-binding', provider });
  }
  return decodeCodecBinding(provider, authority, implementation, artifacts, envelope.data.binding);
}

function parseBoundaryProfile<Profile extends CredentialProfile & JsonValue, Source extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Source>,
  rawProfile: unknown,
): ProviderBindingResult<ProviderProfileEnvelope> {
  const profile = authority.profileParser(snapshotBoundaryData(rawProfile, 'Provider profile parser input'));
  return profile.success
    ? bindingSuccess(
        snapshotBoundaryData({ provider, profile: jsonValueSchema.parse(profile.data) }, 'Decoded provider profile'),
      )
    : bindingFailure({ reason: 'profile-unavailable', provider, selector: `${provider} credential profile` });
}

export function eraseBindingCodec<
  Plan extends ProviderExecutionPlan,
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue,
  Source extends JsonValue,
>(
  provider: string,
  codec: ProviderBindingCodec<Selection, Profile, Subject, Source>,
  implementation: ProviderImplementation<Plan, Source>,
  artifacts: ProviderArtifactCapability<Source>,
): ErasedProviderBindingBoundary {
  const authority = captureBindingAuthority(codec);

  const boundary: ErasedProviderBindingBoundary = {
    provider,
    bindingContract: authority.bindingContract,
    bindingKind: authority.bindingKind,
    captureSelection: (context: ProviderSelectionCaptureContext) =>
      captureBoundarySelection(provider, authority, context),
    canonicalizeProfile: (envelope: ProviderSelectionEnvelope, runtime: ProviderBindingRuntime) =>
      canonicalizeBoundaryProfile(provider, authority, envelope, runtime),
    bindProfile: (envelope: ProviderProfileEnvelope, runtime: ProviderBindingRuntime) =>
      bindBoundaryProfile(provider, authority, implementation, artifacts, envelope, runtime),
    selectorLabel: (rawSelection: unknown) => {
      const parsed = authority.selectionParser(snapshotBoundaryData(rawSelection, 'Provider selector parser input'));
      if (!parsed.success) throw parsed.error;
      return authority.selectorLabel(
        snapshotBoundaryData(jsonValueSchema.parse(parsed.data), 'Provider selector input'),
      );
    },
    decode: (envelope: ProviderBindingEnvelope) =>
      decodeBoundaryEnvelope(provider, authority, implementation, artifacts, envelope),
    parseProfile: (profile: unknown) => parseBoundaryProfile(provider, authority, profile),
    renderFailure: (failure: ProviderBindingFailure) =>
      authority.renderFailure(snapshotBoundaryData(failure, 'Provider binding failure')),
  };
  return Object.freeze(boundary);
}
