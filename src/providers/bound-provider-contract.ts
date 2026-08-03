import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  HostRef,
  ProviderArtifactHandle,
  ProviderArtifactDiscardReconciliation,
  ProviderCurationPreparationRuntime,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderEventBody,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
} from './contract.js';
import type { ProviderCliRequest } from './protocol.js';
import type { ProviderCliRunner } from './protocol.js';
import type {
  ProviderBindingResult,
  ProviderBindingRuntime,
  ProviderBindingUse,
  ProviderReadiness,
} from './contracts/binding.js';
import type { ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';
import type { ProviderValidatedContinuityBlob } from '../sessions/continuity.js';
import type { ProviderValidatedSessionContinuityMutation } from '../sessions/continuity-mutation.js';

export type BoundProviderRecovery = Omit<ProviderRecoveryContract, 'finalizeInterrupted' | 'finalizeFromArtifacts'> & {
  finalizeInterrupted(
    ...args: Parameters<ProviderRecoveryContract['finalizeInterrupted']>
  ): ProviderValidatedSessionContinuityMutation;
  finalizeFromArtifacts(
    options: Omit<Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0], 'access'>,
  ): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>;
};

export type BoundProviderArtifacts =
  | {
      readonly kind: 'managed';
      readonly protocol: 'provider-artifact-discard.v1';
      discardArtifacts(options: {
        handles: readonly ProviderArtifactHandle[];
        actionId: string;
        payloadHash: string;
        runtime: ArtifactCleanupRuntime;
      }): Promise<DiscardOutcome>;
      reconcileDiscard(options: {
        handles: readonly ProviderArtifactHandle[];
        actionId: string;
        payloadHash: string;
        runtime: ArtifactCleanupRuntime;
      }): Promise<ProviderArtifactDiscardReconciliation>;
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
  complete(): Promise<string>;
}>;

export type BoundProviderExecutionPreparationInput = {
  request: ProviderRequest;
  persistedContinuity?: ProviderRuntime['persistedContinuity'];
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<ProviderRuntime['storage'], 'existsSync'>;
};

export type BoundProviderHostPreparationInput = Omit<BoundProviderExecutionPreparationInput, 'protectedEnv'>;

type BoundProviderExecutionRuntimeCommon = Omit<
  ProviderRuntime<never>,
  'transport' | 'executionPlan' | 'appServerSession' | 'runCli'
> &
  Readonly<{
    jobId: string;
  }>;

export type BoundProviderAppServerExecutionRuntime = BoundProviderExecutionRuntimeCommon &
  Readonly<{
    transport: 'app-server';
    onAppServerWaiting(observation: { provider: string }): void;
    onHostRef(hostRef: HostRef): void;
  }>;

export type BoundProviderStandaloneExecutionRuntime = BoundProviderExecutionRuntimeCommon &
  Readonly<{ transport: 'standalone'; runCli: ProviderCliRunner }>;

export type BoundProviderExecutionRuntime =
  | BoundProviderAppServerExecutionRuntime
  | BoundProviderStandaloneExecutionRuntime;

export interface BoundProviderAppServerCapability {
  readonly supportsInterrupt: boolean;
  readonly supportsProbe: boolean;
  openReplacement(
    input: BoundProviderHostPreparationInput,
    runtime: { jobId: string; signal?: AbortSignal },
  ): Promise<Readonly<{ hostRef: HostRef; close(): void }>>;
  interrupt(
    hostRef: HostRef,
    continuity: NonNullable<ProviderRuntime['persistedContinuity']>,
    input: BoundProviderHostPreparationInput & Readonly<{ jobId: string }>,
  ): Promise<boolean>;
  probe(
    hostRef: HostRef,
    continuity: NonNullable<ProviderRuntime['persistedContinuity']>,
    input: BoundProviderHostPreparationInput & Readonly<{ jobId: string }>,
  ): Promise<
    | { kind: 'stale' }
    | {
        kind: 'probed';
        result: { resumable: boolean; updatedContinuity?: NonNullable<ProviderRuntime['persistedContinuity']> };
      }
  >;
}

export type BoundProviderPreparedExecution =
  | Readonly<{
      kind: 'app-server';
      execute(runtime: BoundProviderAppServerExecutionRuntime): AsyncIterable<ProviderEventBody>;
    }>
  | Readonly<{
      kind: 'standalone';
      prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
      execute(runtime: BoundProviderStandaloneExecutionRuntime): AsyncIterable<ProviderEventBody>;
    }>;

export interface BoundProvider {
  readonly name: string;
  readonly envelope: ProviderBindingEnvelope;
  present(): string;
  readiness(
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderReadiness>>;
  compareIdentity(otherEnvelope: unknown): ProviderBindingResult<true>;
  decodeContinuity(rawContinuity: unknown): ProviderBindingResult<ProviderValidatedContinuityBlob | undefined>;
  preflight(input: Omit<ProviderPreflightInput, 'access'>): Promise<void>;
  prepareExecution(input: BoundProviderExecutionPreparationInput): BoundProviderPreparedExecution;
  readonly appServer?: BoundProviderAppServerCapability;
  readonly recovery?: BoundProviderRecovery;
  readonly artifacts: BoundProviderArtifacts;
  readonly curation?: BoundProviderCuration;
}
