import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  ProviderAppServerContract,
  ProviderArtifactHandle,
  ProviderCurationCompleteRuntime,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderEventBody,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerSpec,
} from './contract.js';
import type { ProviderCliRequest } from './protocol.js';
import type {
  ProviderBindingResult,
  ProviderBindingRuntime,
  ProviderBindingUse,
  ProviderReadiness,
} from './contracts/binding.js';
import type { ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';

export interface BoundProviderPreparedExecution {
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
  execute(runtime: Omit<ProviderRuntime<never>, 'providerContext'>): AsyncIterable<ProviderEventBody>;
  readonly appServer?: Omit<ProviderAppServerContract<never>, 'buildServerSpec'> & {
    buildServerSpec(
      persistedContinuity: Parameters<ProviderAppServerContract<never>['buildServerSpec']>[1],
      ports: Parameters<ProviderAppServerContract<never>['buildServerSpec']>[2],
    ): ProviderServerSpec;
  };
}

export type BoundProviderRecovery = Omit<ProviderRecoveryContract, 'finalizeFromArtifacts'> & {
  finalizeFromArtifacts(
    options: Omit<Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0], 'source'>,
  ): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>;
};

export type BoundProviderArtifacts =
  | {
      readonly kind: 'managed';
      discardArtifacts(options: {
        handles: readonly ProviderArtifactHandle[];
        runtime: ArtifactCleanupRuntime;
      }): Promise<DiscardOutcome>;
      locateArtifact?(options: {
        conversationRef: string;
        runtime: ArtifactCleanupRuntime;
      }): ProviderArtifactHandle | null;
    }
  | { readonly kind: 'none'; readonly reason: string };

export interface BoundProviderCuration {
  complete(request: ProviderCurationRequest, runtime: ProviderCurationCompleteRuntime): Promise<string>;
  isUsageBudgetExhausted(runtime: ProviderCurationUsageRuntime): boolean;
}

export interface BoundProvider {
  readonly name: string;
  readonly envelope: ProviderBindingEnvelope;
  present(): string;
  readiness(
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderReadiness>>;
  compareIdentity(otherEnvelope: unknown): ProviderBindingResult<true>;
  preflight(input: Omit<ProviderPreflightInput, 'credentialSource'>): Promise<void>;
  prepareExecution(input: {
    request: ProviderRequest;
    baseEnv: Readonly<Record<string, string>>;
    protectedEnv?: Readonly<Record<string, string>>;
    platform: string;
  }): BoundProviderPreparedExecution;
  readonly recovery?: BoundProviderRecovery;
  readonly artifacts: BoundProviderArtifacts;
  readonly curation?: BoundProviderCuration;
}
