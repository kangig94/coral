import type { ProviderCatalog } from './catalog.js';
import type { ProviderArtifactCapability, ProviderImplementation } from './contract.js';
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
} from './contracts/binding.js';
import { providerBindingEnvelopeSchema, type ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';
import type { JsonValue } from '../infra/json-value.js';
import {
  providerProfileEnvelopeSchema,
  providerScopeSchema,
  type ProviderProfileEnvelope,
  type ProviderProfileSet,
  type ProviderScope,
} from '../infra/provider-scope.js';
import { zodPersistedContract, type CanonicalContractValue } from '../store/format-fingerprint.js';
import { snapshotBoundaryData } from './internal/snapshot.js';
import { snapshotArtifacts, snapshotImplementation } from './internal/definition-boundary.js';
import { eraseBindingCodec, type ErasedProviderBindingBoundary } from './internal/binding-boundary.js';
import type { BoundProvider } from './bound-provider-contract.js';

declare const providerDefinitionBrand: unique symbol;

export type ProviderDefinition = {
  readonly name: string;
  readonly [providerDefinitionBrand]: true;
};

export type ProviderDefinitionInput<Context, Source extends JsonValue> = ProviderImplementation<Context, Source>;

export interface ProviderBindingBuilder<Source extends JsonValue> {
  binding<
    Selection extends JsonValue,
    Profile extends CredentialProfile & JsonValue,
    Subject extends AccountSubject & JsonValue = AccountSubject & JsonValue,
  >(
    codec: ProviderBindingCodec<Selection, Profile, Subject, Source>,
  ): ProviderArtifactBuilder<Source>;
}

export interface ProviderArtifactBuilder<Source extends JsonValue> {
  artifacts(capability: ProviderArtifactCapability<Source>): ProviderBuildBuilder;
}

interface ProviderBuildBuilder {
  build(): ProviderDefinition;
}

const registeredBindingBoundaries = new WeakMap<ProviderDefinition, ErasedProviderBindingBoundary>();

function registeredBindingBoundary(definition: ProviderDefinition): ErasedProviderBindingBoundary {
  const boundary = registeredBindingBoundaries.get(definition);
  if (boundary === undefined) throw new Error('Provider definition has no registered binding provenance.');
  return boundary;
}

export function defineProvider<Context, Source extends JsonValue>(
  spec: ProviderDefinitionInput<Context, Source>,
): ProviderBindingBuilder<Source> {
  const definitionInput = snapshotImplementation(spec);
  if (
    definitionInput.appServer !== undefined &&
    (definitionInput.recovery === undefined || typeof definitionInput.recovery.finalizeInterrupted !== 'function')
  ) {
    throw new Error(`App-server provider '${definitionInput.name}' must define recovery interpretation.`);
  }
  return {
    binding(codec) {
      return {
        artifacts(capability) {
          const artifacts = snapshotArtifacts(capability);
          const binding = eraseBindingCodec(definitionInput.name, codec, definitionInput, artifacts);
          return {
            build() {
              const definition = Object.freeze({
                name: definitionInput.name,
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

export type ProviderPersistedCodecComponent = Readonly<{ name: string; contract: CanonicalContractValue }>;

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
    const binding = registeredBindingBoundary(spec);
    const name = binding.provider;
    if (this.sealed) throw new Error(`Provider registry is sealed; cannot register '${name}'.`);
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new Error(`Provider name "${name}" is reserved`);
    }
    if (!PERSISTED_PROVIDER_NAME.test(name)) {
      throw new TypeError(`Provider name "${name}" cannot form a stable persisted codec name.`);
    }
    if (this.providers.has(name)) {
      throw new Error(`New provider "${name}" is already registered`);
    }
    this.providers.set(name, { definition: spec, binding });
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
    return bindingSuccess(snapshotBoundaryData(profiles, 'Captured provider profiles'));
  }

  async captureScope(
    origin: { readonly origin: 'caller' } | { readonly origin: 'system'; readonly name: string },
    providerNames: readonly string[],
    context: ProviderSelectionCaptureContext,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderScope>> {
    const profiles = await this.captureProfiles(providerNames, context, runtime);
    if (!profiles.ok) return profiles;
    const canonicalOrigin = snapshotBoundaryData(origin, 'Provider scope origin');
    return bindingSuccess(
      snapshotBoundaryData(
        providerScopeSchema.parse({ ...canonicalOrigin, profiles: profiles.value }),
        'Captured provider scope',
      ),
    );
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
      const profile = registration.binding.parseProfile(envelope.profile);
      if (!profile.ok) {
        return bindingFailure({
          reason: 'profile-unavailable',
          provider: envelope.provider,
          selector: `${envelope.provider} credential profile`,
        });
      }
      profiles.push(profile.value);
    }

    return bindingSuccess(
      snapshotBoundaryData(
        providerScopeSchema.parse({
          ...scope.data,
          profiles,
        }),
        'Decoded provider scope',
      ),
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
  ): Promise<ProviderBindingResult<BoundProvider>> {
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
  ): Promise<ProviderBindingResult<BoundProvider>> {
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

  rehydrateBinding(rawEnvelope: unknown): ProviderBindingResult<BoundProvider> {
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
      Object.freeze({
        name: 'provider.binding-envelope',
        contract: snapshotBoundaryData(
          zodPersistedContract(providerBindingEnvelopeSchema),
          'Provider binding envelope persisted contract',
        ),
      }),
      ...[...this.providers.entries()].map(([providerName, { binding }]) =>
        Object.freeze({
          name: `provider.${providerName}.binding`,
          contract: binding.bindingContract,
        }),
      ),
    ]);
    return this.sealedComponents;
  }
}
