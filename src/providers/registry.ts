import type { ProviderCatalog } from './catalog.js';
import type { ProviderArtifactCapability, ProviderSpec } from './contract.js';
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
  type ProviderReadiness,
  type ProviderSelectionCaptureContext,
  type ProviderSelectionEnvelope,
} from './contracts/binding.js';
import { providerBindingEnvelopeSchema, type ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';
import { jsonValueSchema, type JsonValue } from '../infra/json-value.js';
import {
  providerProfileEnvelopeSchema,
  providerScopeSchema,
  type ProviderProfileEnvelope,
  type ProviderProfileSet,
  type ProviderScope,
} from '../infra/provider-scope.js';
import type { ProviderCredentialSourceRef } from '../infra/provider-credential-sources.js';
import type { z } from 'zod';

declare const providerDefinitionBrand: unique symbol;

export type ProviderDefinition = ProviderSpec & {
  readonly artifacts: ProviderArtifactCapability;
  readonly [providerDefinitionBrand]: true;
};

export type ProviderDefinitionInput = Pick<ProviderSpec, 'name' | 'run'> &
  Partial<Pick<ProviderSpec, 'preflight' | 'appServer' | 'recovery'>>;

export interface ProviderBindingBuilder {
  binding<
    Selection extends JsonValue,
    Profile extends CredentialProfile & JsonValue,
    Subject extends AccountSubject & JsonValue = AccountSubject & JsonValue,
  >(
    codec: ProviderBindingCodec<Selection, Profile, Subject>,
  ): ProviderArtifactBuilder;
}

export interface RehydratedProviderBinding {
  readonly provider: string;
  readonly envelope: ProviderBindingEnvelope;
  present(): string;
  readiness(
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderReadiness>>;
  credentialSource(): ProviderCredentialSourceRef;
  compareIdentity(otherEnvelope: unknown): ProviderBindingResult<true>;
}

interface ErasedProviderBindingBoundary {
  readonly selectionSchema: z.ZodTypeAny;
  readonly profileSchema: z.ZodTypeAny;
  readonly bindingSchema: z.ZodTypeAny;
  readonly bindingKind: 'account' | 'profile';
  captureSelection(context: ProviderSelectionCaptureContext): ProviderBindingResult<ProviderSelectionEnvelope>;
  canonicalizeProfile(
    envelope: ProviderSelectionEnvelope,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderProfileEnvelope>>;
  bindProfile(
    envelope: ProviderProfileEnvelope,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<RehydratedProviderBinding>>;
  selectorLabel(rawSelection: unknown): string;
  decode(envelope: ProviderBindingEnvelope): ProviderBindingResult<RehydratedProviderBinding>;
  renderFailure(failure: ProviderBindingFailure): string;
}

export interface ProviderArtifactBuilder {
  artifacts(capability: ProviderArtifactCapability): ProviderBuildBuilder;
}

interface ProviderBuildBuilder {
  build(): ProviderDefinition;
}

const registeredBindingBoundaries = new WeakMap<ProviderDefinition, ErasedProviderBindingBoundary>();

function freezeAuthority<T extends object>(value: T): T {
  return Object.freeze(value);
}

function registeredBindingBoundary(definition: ProviderDefinition): ErasedProviderBindingBoundary {
  const boundary = registeredBindingBoundaries.get(definition);
  if (boundary === undefined) throw new Error(`Provider '${definition.name}' has no registered binding boundary.`);
  return boundary;
}

function rehydrateCodecBinding<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue,
>(
  provider: string,
  codec: ProviderBindingCodec<Selection, Profile, Subject>,
  binding: unknown,
): RehydratedProviderBinding {
  const canonicalEnvelope = Object.freeze({
    provider,
    kind: codec.bindingKind,
    binding: jsonValueSchema.parse(binding),
  });
  const presentation = codec.presentBinding(binding as never);
  return Object.freeze({
    provider,
    envelope: canonicalEnvelope,
    present: () => presentation,
    readiness: (use: ProviderBindingUse, runtime: ProviderBindingRuntime) =>
      codec.readiness(binding as never, use, runtime),
    credentialSource: () => codec.credentialSource(binding as never),
    compareIdentity(otherEnvelope: unknown) {
      const envelope = providerBindingEnvelopeSchema.safeParse(otherEnvelope);
      if (!envelope.success || envelope.data.provider !== provider || envelope.data.kind !== codec.bindingKind) {
        return bindingFailure({ reason: 'invalid-persisted-binding', provider });
      }
      const otherBinding = codec.bindingSchema.safeParse(envelope.data.binding);
      return otherBinding.success
        ? codec.compareBinding(binding as never, otherBinding.data as never)
        : bindingFailure({ reason: 'invalid-persisted-binding', provider });
    },
  });
}

function eraseBindingCodec<
  Selection extends JsonValue,
  Profile extends CredentialProfile & JsonValue,
  Subject extends AccountSubject & JsonValue,
>(provider: string, codec: ProviderBindingCodec<Selection, Profile, Subject>): ErasedProviderBindingBoundary {
  const codecSnapshot = freezeAuthority(codec);
  const { selectionSchema, profileSchema, bindingSchema, bindingKind } = codecSnapshot;

  return Object.freeze({
    selectionSchema,
    profileSchema,
    bindingSchema,
    bindingKind,
    captureSelection(context: ProviderSelectionCaptureContext) {
      const captured = codecSnapshot.captureSelection(context);
      return captured.ok ? bindingSuccess({ provider, selection: jsonValueSchema.parse(captured.value) }) : captured;
    },
    async canonicalizeProfile(rawEnvelope: ProviderSelectionEnvelope, runtime: ProviderBindingRuntime) {
      const envelope = providerSelectionEnvelopeSchema.safeParse(rawEnvelope);
      if (!envelope.success || envelope.data.provider !== provider) {
        return bindingFailure({ reason: 'unsupported-selection', provider, selector: `${provider} selection` });
      }
      const selection = selectionSchema.safeParse(envelope.data.selection);
      if (!selection.success) {
        return bindingFailure({ reason: 'unsupported-selection', provider, selector: `${provider} selection` });
      }
      const profile = await codecSnapshot.canonicalizeProfile(selection.data, runtime);
      return profile.ok ? bindingSuccess({ provider, profile: jsonValueSchema.parse(profile.value) }) : profile;
    },
    async bindProfile(rawEnvelope: ProviderProfileEnvelope, runtime: ProviderBindingRuntime) {
      const envelope = providerProfileEnvelopeSchema.safeParse(rawEnvelope);
      if (!envelope.success || envelope.data.provider !== provider) {
        return bindingFailure({ reason: 'missing-profile', provider });
      }
      const profile = profileSchema.safeParse(envelope.data.profile);
      if (!profile.success) {
        return bindingFailure({
          reason: 'profile-unavailable',
          provider,
          selector: `${provider} credential profile`,
        });
      }
      const binding = await codecSnapshot.bindProfile(profile.data, runtime);
      return binding.ok ? bindingSuccess(rehydrateCodecBinding(provider, codecSnapshot, binding.value)) : binding;
    },
    selectorLabel: (rawSelection: unknown) => codecSnapshot.selectorLabel(selectionSchema.parse(rawSelection)),
    decode(rawEnvelope: ProviderBindingEnvelope) {
      const envelope = providerBindingEnvelopeSchema.safeParse(rawEnvelope);
      if (!envelope.success) return bindingFailure({ reason: 'invalid-persisted-binding', provider });
      if (envelope.data.provider !== provider || envelope.data.kind !== bindingKind) {
        return bindingFailure({ reason: 'invalid-persisted-binding', provider });
      }
      const binding = bindingSchema.safeParse(envelope.data.binding);
      return binding.success
        ? bindingSuccess(rehydrateCodecBinding(provider, codecSnapshot, binding.data))
        : bindingFailure({ reason: 'invalid-persisted-binding', provider });
    },
    renderFailure(failure: ProviderBindingFailure) {
      return codecSnapshot.renderFailure(failure);
    },
  });
}

export function defineProvider(spec: ProviderDefinitionInput): ProviderBindingBuilder {
  const definitionInput = freezeAuthority(spec);
  return {
    binding(codec) {
      const binding = eraseBindingCodec(definitionInput.name, codec);
      return {
        artifacts(capability) {
          const artifacts = freezeAuthority(capability);
          return {
            build() {
              const definition = Object.freeze({
                ...definitionInput,
                ...(definitionInput.appServer === undefined
                  ? {}
                  : { appServer: freezeAuthority(definitionInput.appServer) }),
                ...(definitionInput.recovery === undefined
                  ? {}
                  : { recovery: freezeAuthority(definitionInput.recovery) }),
                artifacts,
              }) as ProviderDefinition;
              registeredBindingBoundaries.set(definition, binding);
              return definition;
            },
          };
        },
      };
    },
  };
}

export type ProviderPersistedCodecComponent = Readonly<{ name: string; schema: z.ZodTypeAny }>;

const RESERVED_TOOL_NAMES = new Set([
  'wait',
  'workflow',
  'abort',
  'backend',
  'kb_search',
  'kb_read',
  'kb_promote',
  'kb_update',
  'kb_delete',
  'kb_source_import',
  'kb_source_list',
  'kb_source_delete',
  'kb_reindex',
  'kb_principles',
  'kb_memo',
  'kb_memo_list',
  'kb_memo_delete',
  'kb_memo_purge',
  'discuss_seed',
  'discuss_start',
  'discuss_watch',
  'discuss_participate',
  'discuss_abort',
]);
const PERSISTED_PROVIDER_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export class ProviderRegistry implements ProviderCatalog {
  private sealed = false;
  private sealedComponents: readonly ProviderPersistedCodecComponent[] | undefined;
  private providers = new Map<
    string,
    { readonly definition: ProviderDefinition; readonly binding: ErasedProviderBindingBoundary }
  >();

  register(spec: ProviderDefinition): void {
    if (this.sealed) throw new Error(`Provider registry is sealed; cannot register '${spec.name}'.`);
    if (RESERVED_TOOL_NAMES.has(spec.name)) {
      throw new Error(`Provider name "${spec.name}" is reserved`);
    }
    if (!PERSISTED_PROVIDER_NAME.test(spec.name)) {
      throw new TypeError(`Provider name "${spec.name}" cannot form a stable persisted codec name.`);
    }
    if (this.providers.has(spec.name)) {
      throw new Error(`New provider "${spec.name}" is already registered`);
    }
    this.providers.set(spec.name, { definition: spec, binding: registeredBindingBoundary(spec) });
  }

  get(name: string): ProviderDefinition | undefined {
    return this.providers.get(name)?.definition;
  }

  getAll(): ProviderDefinition[] {
    return [...this.providers.values()].map((provider) => provider.definition);
  }

  captureSelection(
    providerName: string,
    context: ProviderSelectionCaptureContext,
  ): ProviderBindingResult<ProviderSelectionEnvelope> {
    const registration = this.providers.get(providerName);
    if (registration === undefined) {
      return bindingFailure({ reason: 'unsupported-selection', provider: providerName, selector: providerName });
    }
    return registration.binding.captureSelection(context);
  }

  async resolveProfile(
    rawSelectionEnvelope: unknown,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderProfileEnvelope>> {
    const envelope = providerSelectionEnvelopeSchema.safeParse(rawSelectionEnvelope);
    if (!envelope.success) {
      return bindingFailure({ reason: 'unsupported-selection', provider: 'unknown', selector: 'provider selection' });
    }
    const registration = this.providers.get(envelope.data.provider);
    if (registration === undefined) {
      return bindingFailure({
        reason: 'unsupported-selection',
        provider: envelope.data.provider,
        selector: envelope.data.provider,
      });
    }
    return registration.binding.canonicalizeProfile(envelope.data, runtime);
  }

  async captureProfiles(
    providerNames: readonly string[],
    context: ProviderSelectionCaptureContext,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderProfileSet>> {
    const profiles: ProviderProfileEnvelope[] = [];
    for (const providerName of new Set(providerNames)) {
      const selection = this.captureSelection(providerName, context);
      if (!selection.ok) return selection;
      const profile = await this.resolveProfile(selection.value, runtime);
      if (!profile.ok) return profile;
      profiles.push(profile.value);
    }
    return bindingSuccess(Object.freeze(profiles));
  }

  async captureScope(
    origin: { readonly origin: 'caller' } | { readonly origin: 'system'; readonly name: string },
    providerNames: readonly string[],
    context: ProviderSelectionCaptureContext,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderScope>> {
    const profiles = await this.captureProfiles(providerNames, context, runtime);
    if (!profiles.ok) return profiles;
    return bindingSuccess(providerScopeSchema.parse({ ...origin, profiles: profiles.value }));
  }

  decodeScope(rawScope: unknown): ProviderBindingResult<ProviderScope> {
    const scope = providerScopeSchema.safeParse(rawScope);
    if (!scope.success) {
      return bindingFailure({ reason: 'unsupported-selection', provider: 'unknown', selector: 'provider scope' });
    }

    const seen = new Set<string>();
    const profiles: ProviderProfileEnvelope[] = [];
    for (const envelope of scope.data.profiles) {
      if (seen.has(envelope.provider)) {
        return bindingFailure({
          reason: 'unsupported-selection',
          provider: envelope.provider,
          selector: `duplicate ${envelope.provider} credential profile`,
        });
      }
      seen.add(envelope.provider);

      const registration = this.providers.get(envelope.provider);
      if (registration === undefined) {
        return bindingFailure({
          reason: 'unsupported-selection',
          provider: envelope.provider,
          selector: envelope.provider,
        });
      }
      const profile = registration.binding.profileSchema.safeParse(envelope.profile);
      if (!profile.success) {
        return bindingFailure({
          reason: 'profile-unavailable',
          provider: envelope.provider,
          selector: `${envelope.provider} credential profile`,
        });
      }
      profiles.push({ provider: envelope.provider, profile: jsonValueSchema.parse(profile.data) });
    }

    return bindingSuccess(
      providerScopeSchema.parse({
        ...scope.data,
        profiles,
      }),
    );
  }

  decodeCompleteScope(rawScope: unknown, requiredProviders: readonly string[]): ProviderBindingResult<ProviderScope> {
    const scope = this.decodeScope(rawScope);
    if (!scope.ok) return scope;
    const present = new Set(scope.value.profiles.map((profile) => profile.provider));
    const missingProvider = [...new Set(requiredProviders)].find((provider) => !present.has(provider));
    return missingProvider === undefined
      ? scope
      : bindingFailure({ reason: 'missing-profile', provider: missingProvider });
  }

  async bindFromScope(
    rawScope: unknown,
    providerName: string,
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<RehydratedProviderBinding>> {
    const scope = this.decodeCompleteScope(rawScope, [providerName]);
    if (!scope.ok) return scope;
    const profile = scope.value.profiles.find((candidate) => candidate.provider === providerName);
    const binding = await this.bindProfile(providerName, profile, runtime);
    if (!binding.ok) return binding;
    const readiness = await binding.value.readiness(use, runtime);
    return readiness.ok ? bindingSuccess(binding.value) : bindingFailure(readiness.failure);
  }

  async bindProfile(
    providerName: string,
    rawProfileEnvelope: unknown,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<RehydratedProviderBinding>> {
    if (rawProfileEnvelope === undefined) return bindingFailure({ reason: 'missing-profile', provider: providerName });
    const registration = this.providers.get(providerName);
    if (registration === undefined) {
      return bindingFailure({ reason: 'unsupported-selection', provider: providerName, selector: providerName });
    }
    const envelope = providerProfileEnvelopeSchema.safeParse(rawProfileEnvelope);
    if (!envelope.success || envelope.data.provider !== providerName) {
      return bindingFailure({
        reason: 'profile-unavailable',
        provider: providerName,
        selector: `${providerName} credential profile`,
      });
    }
    return registration.binding.bindProfile(envelope.data, runtime);
  }

  rehydrateBinding(rawEnvelope: unknown): ProviderBindingResult<RehydratedProviderBinding> {
    const parsed = providerBindingEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return bindingFailure({ reason: 'invalid-persisted-binding', provider: 'unknown' });
    }
    const envelope: ProviderBindingEnvelope = parsed.data;
    const registration = this.providers.get(envelope.provider);
    if (registration === undefined) {
      return bindingFailure({ reason: 'invalid-persisted-binding', provider: envelope.provider });
    }
    return registration.binding.decode(envelope);
  }

  renderBindingFailure(failure: ProviderBindingFailure): string {
    const registration = this.providers.get(failure.provider);
    if (registration !== undefined) return registration.binding.renderFailure(failure);

    const available = [...this.providers.keys()].sort();
    const choices = available.length === 0 ? 'No providers are registered.' : `Choose one of: ${available.join(', ')}.`;
    if (failure.reason === 'unsupported-selection') {
      return `Provider '${failure.provider}' is not registered. ${choices} See docs/configuration.md#multi-account-provider-routing.`;
    }
    return `Provider binding failed for unregistered provider '${failure.provider}': ${failure.reason}. ${choices} See docs/configuration.md#multi-account-provider-routing.`;
  }

  selectorLabel(providerName: string, rawSelection: unknown): string {
    const registration = this.providers.get(providerName);
    if (registration === undefined) throw new Error(`unsupported_provider_selection: ${providerName}`);
    return registration.binding.selectorLabel(rawSelection);
  }

  sealPersistedBindingCodecComponents(): readonly ProviderPersistedCodecComponent[] {
    if (this.sealedComponents !== undefined) return this.sealedComponents;
    this.sealed = true;
    this.sealedComponents = Object.freeze([
      Object.freeze({ name: 'provider.binding-envelope', schema: providerBindingEnvelopeSchema }),
      ...[...this.providers.entries()].map(([providerName, { binding }]) =>
        Object.freeze({
          name: `provider.${providerName}.binding`,
          schema: binding.bindingSchema,
        }),
      ),
    ]);
    return this.sealedComponents;
  }
}
