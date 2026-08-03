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
import type { AppServerHostAuthority } from './app-server-host.js';

export interface ErasedProviderBindingBoundary {
  readonly provider: string;
  readonly artifactKind: ProviderArtifactCapability['kind'];
  readonly artifactProtocol: string | null | undefined;
  readonly hasArtifactReconciliation: boolean;
  readonly profileContract: CanonicalContractValue;
  readonly bindingContract: CanonicalContractValue;
  readonly continuityContract: CanonicalContractValue;
  readonly bindingKind: 'account' | 'profile';
  captureSelection(context: ProviderSelectionCaptureContext): ProviderBindingResult<ProviderSelectionEnvelope>;
  canonicalizeProfile(
    envelope: ProviderSelectionEnvelope,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderProfileEnvelope>>;
  bindProfile(
    envelope: ProviderProfileEnvelope,
    runtime: ProviderBindingRuntime,
    appServerHost: AppServerHostAuthority | undefined,
  ): Promise<ProviderBindingResult<BoundProvider>>;
  selectorLabel(rawSelection: unknown): string;
  decode(
    envelope: ProviderBindingEnvelope,
    appServerHost: AppServerHostAuthority | undefined,
  ): ProviderBindingResult<BoundProvider>;
  parseProfile(rawProfile: unknown): ProviderBindingResult<ProviderProfileEnvelope>;
  renderFailure(failure: ProviderBindingFailure): string;
}

interface CapturedBindingAuthority<Profile extends CredentialProfile & JsonValue, Access extends JsonValue> {
  readonly selectionParser: ProviderValueParser<JsonValue>;
  readonly profileParser: ProviderValueParser<Profile>;
  readonly profileContract: CanonicalContractValue;
  readonly bindingParser: ProviderValueParser<unknown>;
  readonly bindingContract: CanonicalContractValue;
  readonly continuityContract: CanonicalContractValue;
  readonly continuityParser: ProviderValueParser<Record<string, unknown>>;
  readonly bindingKind: 'account' | 'profile';
  readonly boundCodec: CapturedBoundCodec<Access>;
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
  Access extends JsonValue,
>(codec: ProviderBindingCodec<Selection, Profile, Subject, Access>): CapturedBindingAuthority<Profile, Access> {
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
    profileParser: receiver.persistedProfile.parse,
    profileContract: snapshotBoundaryData(receiver.persistedProfile.contract, 'Provider persisted profile contract'),
    bindingParser: receiver.persistedBinding.parse,
    bindingContract: snapshotBoundaryData(receiver.persistedBinding.contract, 'Provider persisted binding contract'),
    continuityContract: snapshotBoundaryData(
      receiver.persistedContinuity.contract,
      'Provider persisted continuity contract',
    ),
    continuityParser: receiver.persistedContinuity.parse,
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
  Access extends JsonValue,
>(receiver: ProviderBindingCodec<Selection, Profile, Subject, Access>): CapturedBoundCodec<Access> {
  const { bindingKind, presentBinding, access, readiness, compareBinding } = receiver;
  const bindingParser = receiver.persistedBinding.parse;
  const continuityParser = receiver.persistedContinuity.parse;
  return Object.freeze({
    bindingKind,
    parseBinding: (binding: unknown) => bindingParser(binding),
    parseContinuity: (continuity: unknown) => continuityParser(continuity),
    presentBinding: (binding: unknown) => presentBinding.call(receiver, binding as never),
    access: (binding: unknown) => access.call(receiver, binding as never),
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
  Access extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
  implementation: ProviderImplementation<Plan, Access>,
  artifacts: ProviderArtifactCapability<Access>,
  rawBinding: unknown,
  appServerHost: AppServerHostAuthority | undefined,
): ProviderBindingResult<BoundProvider> {
  const binding = authority.bindingParser(snapshotBoundaryData(rawBinding, 'Provider binding parser input'));
  return binding.success
    ? bindingSuccess(
        rehydrateCodecBinding(provider, authority.boundCodec, binding.data, implementation, artifacts, appServerHost),
      )
    : bindingFailure({ reason: 'invalid-persisted-binding', provider });
}

function captureBoundarySelection<Profile extends CredentialProfile & JsonValue, Access extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
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

async function canonicalizeBoundaryProfile<Profile extends CredentialProfile & JsonValue, Access extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
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
  Access extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
  implementation: ProviderImplementation<Plan, Access>,
  artifacts: ProviderArtifactCapability<Access>,
  rawEnvelope: ProviderProfileEnvelope,
  runtime: ProviderBindingRuntime,
  appServerHost: AppServerHostAuthority | undefined,
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
  return binding.ok
    ? decodeCodecBinding(provider, authority, implementation, artifacts, binding.value, appServerHost)
    : binding;
}

function decodeBoundaryEnvelope<
  Plan extends ProviderExecutionPlan,
  Profile extends CredentialProfile & JsonValue,
  Access extends JsonValue,
>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
  implementation: ProviderImplementation<Plan, Access>,
  artifacts: ProviderArtifactCapability<Access>,
  rawEnvelope: ProviderBindingEnvelope,
  appServerHost: AppServerHostAuthority | undefined,
): ProviderBindingResult<BoundProvider> {
  const envelope = providerBindingEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success || envelope.data.provider !== provider || envelope.data.kind !== authority.bindingKind) {
    return bindingFailure({ reason: 'invalid-persisted-binding', provider });
  }
  return decodeCodecBinding(provider, authority, implementation, artifacts, envelope.data.binding, appServerHost);
}

function parseBoundaryProfile<Profile extends CredentialProfile & JsonValue, Access extends JsonValue>(
  provider: string,
  authority: CapturedBindingAuthority<Profile, Access>,
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
  Access extends JsonValue,
>(
  provider: string,
  codec: ProviderBindingCodec<Selection, Profile, Subject, Access>,
  implementation: ProviderImplementation<Plan, Access>,
  artifacts: ProviderArtifactCapability<Access>,
): ErasedProviderBindingBoundary {
  const authority = captureBindingAuthority(codec);

  const boundary: ErasedProviderBindingBoundary = {
    provider,
    artifactKind: artifacts.kind,
    artifactProtocol: artifacts.kind === 'managed' ? artifacts.protocol : null,
    hasArtifactReconciliation: artifacts.kind === 'managed' && typeof artifacts.reconcileDiscard === 'function',
    profileContract: authority.profileContract,
    bindingContract: authority.bindingContract,
    continuityContract: authority.continuityContract,
    bindingKind: authority.bindingKind,
    captureSelection: (context: ProviderSelectionCaptureContext) =>
      captureBoundarySelection(provider, authority, context),
    canonicalizeProfile: (envelope: ProviderSelectionEnvelope, runtime: ProviderBindingRuntime) =>
      canonicalizeBoundaryProfile(provider, authority, envelope, runtime),
    bindProfile: (
      envelope: ProviderProfileEnvelope,
      runtime: ProviderBindingRuntime,
      appServerHost: AppServerHostAuthority | undefined,
    ) => bindBoundaryProfile(provider, authority, implementation, artifacts, envelope, runtime, appServerHost),
    selectorLabel: (rawSelection: unknown) => {
      const parsed = authority.selectionParser(snapshotBoundaryData(rawSelection, 'Provider selector parser input'));
      if (!parsed.success) throw parsed.error;
      return authority.selectorLabel(
        snapshotBoundaryData(jsonValueSchema.parse(parsed.data), 'Provider selector input'),
      );
    },
    decode: (envelope: ProviderBindingEnvelope, appServerHost: AppServerHostAuthority | undefined) =>
      decodeBoundaryEnvelope(provider, authority, implementation, artifacts, envelope, appServerHost),
    parseProfile: (profile: unknown) => parseBoundaryProfile(provider, authority, profile),
    renderFailure: (failure: ProviderBindingFailure) =>
      authority.renderFailure(snapshotBoundaryData(failure, 'Provider binding failure')),
  };
  return Object.freeze(boundary);
}
