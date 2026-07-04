import type { ProviderArtifactCapability, ProviderSpec } from './contract.js';

declare const providerDefinitionBrand: unique symbol;

export type ProviderDefinition = ProviderSpec & {
  readonly artifacts: ProviderArtifactCapability;
  readonly [providerDefinitionBrand]: true;
};

export type ProviderDefinitionInput = Pick<ProviderSpec, 'name' | 'run'> &
  Partial<Pick<ProviderSpec, 'preflight' | 'appServer' | 'recovery'>>;

export interface ProviderArtifactBuilder {
  artifacts(capability: ProviderArtifactCapability): ProviderBuildBuilder;
}

interface ProviderBuildBuilder {
  build(): ProviderDefinition;
}

export function defineProvider(spec: ProviderDefinitionInput): ProviderArtifactBuilder {
  return {
    artifacts(capability) {
      return {
        build() {
          return {
            ...spec,
            artifacts: capability,
          } as ProviderDefinition; // brand is compile-time-only; cast is required and safe
        },
      };
    },
  };
}
