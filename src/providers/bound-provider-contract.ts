import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  ProviderAppServerCapability,
  ProviderArtifactHandle,
  ProviderCurationPreparationRuntime,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderEventBody,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLaunch,
  ProviderServerLease,
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
  prepare(request: ProviderCurationRequest, runtime: ProviderCurationPreparationRuntime): BoundProviderPreparedCuration;
  isUsageBudgetExhausted(runtime: ProviderCurationUsageRuntime): boolean;
}

export type BoundProviderPreparedCuration = Readonly<{
  launch: ProviderServerLaunch;
  complete(runtime: { readonly acquirePreparedServer: () => Promise<ProviderServerLease> }): Promise<string>;
}>;

export type BoundProviderExecutionPreparationInput = {
  request: ProviderRequest;
  persistedContinuity?: ProviderRuntime['persistedContinuity'];
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<ProviderRuntime['storage'], 'existsSync'>;
};

export type BoundProviderPreparedStableHost = Readonly<{ host: ProviderServerSpec }>;

export interface BoundProviderAppServerCapability extends Omit<
  ProviderAppServerCapability<never>,
  'compileStableHost'
> {
  prepareStableHost(
    input: Omit<BoundProviderExecutionPreparationInput, 'protectedEnv'>,
  ): BoundProviderPreparedStableHost;
}

export interface BoundProviderPreparedExecution {
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
  execute(runtime: Omit<ProviderRuntime<never>, 'executionPlan'>): AsyncIterable<ProviderEventBody>;
  readonly appServer?: Omit<BoundProviderAppServerCapability, 'prepareStableHost'> & {
    readonly launch: ProviderServerLaunch;
  };
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
  prepareExecution(input: BoundProviderExecutionPreparationInput): BoundProviderPreparedExecution;
  readonly appServer?: BoundProviderAppServerCapability;
  readonly recovery?: BoundProviderRecovery;
  readonly artifacts: BoundProviderArtifacts;
  readonly curation?: BoundProviderCuration;
}
