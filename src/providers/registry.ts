import type { ProviderCatalog } from './catalog.js';
import type { ProviderArtifactCapability, ProviderSpec } from './contract.js';
import {
  providerBindingEnvelopeSchema,
  type AccountSubject,
  type CredentialProfile,
  type ProviderBindingCodec,
  type ProviderBindingEnvelope,
} from './contracts/binding.js';
import { jsonValueSchema, type JsonValue } from './contracts/json-value.js';
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
}

interface ErasedProviderBindingBoundary {
  readonly selectionSchema: z.ZodTypeAny;
  readonly profileSchema: z.ZodTypeAny;
  readonly bindingSchema: z.ZodTypeAny;
  readonly bindingKind: 'account' | 'profile';
  selectorLabel(rawSelection: unknown): string;
  decode(envelope: ProviderBindingEnvelope): RehydratedProviderBinding;
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
    selectorLabel: (rawSelection: unknown) => codecSnapshot.selectorLabel(selectionSchema.parse(rawSelection)),
    decode(rawEnvelope: ProviderBindingEnvelope) {
      const envelope = providerBindingEnvelopeSchema.parse(rawEnvelope);
      if (envelope.provider !== provider || envelope.kind !== bindingKind) {
        throw new Error(`invalid_provider_binding_envelope: expected ${provider}/${bindingKind}`);
      }
      const binding = bindingSchema.parse(envelope.binding);
      const canonicalEnvelope = Object.freeze({
        provider,
        kind: bindingKind,
        binding: jsonValueSchema.parse(binding),
      });
      const presentation = codecSnapshot.presentBinding(binding as never);
      return Object.freeze({
        provider,
        envelope: canonicalEnvelope,
        present: () => presentation,
      });
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

  rehydrateBinding(rawEnvelope: unknown): RehydratedProviderBinding {
    const envelope: ProviderBindingEnvelope = providerBindingEnvelopeSchema.parse(rawEnvelope);
    const registration = this.providers.get(envelope.provider);
    if (registration === undefined) {
      throw new Error(`invalid_provider_binding_envelope: provider '${envelope.provider}' is not registered`);
    }
    return registration.binding.decode(envelope);
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
