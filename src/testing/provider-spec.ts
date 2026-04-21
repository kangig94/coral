import type {
  PreflightRuntime,
  ProviderAppServerContract,
  ProviderArtifactCleanup,
  ProviderContinuityBlob,
  ProviderEventBody,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
  ProviderSpec,
  ProviderTerminalEventBody,
} from '../providers/contract.js';

export type { ArtifactCleanupRuntime, PreflightRuntime } from '../providers/contract.js';

type TestProviderInvocation = (
  request: ProviderRequest,
  runtime: ProviderRuntime,
) => AsyncIterable<ProviderEventBody>;

type TestAppServerLifecycle = {
  buildServerSpec(
    persistedContinuity: ProviderContinuityBlob | undefined,
    request: ProviderRequest,
  ): ProviderServerSpec;
  interrupt(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<void>;
  probe?(
    lease: ProviderServerLease,
    continuity: ProviderContinuityBlob,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  finalizeInterrupted?(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob,
  ): {
    conversationRef?: string;
    nonResumable?: boolean;
    continuityMutation?: ProviderContinuityBlob;
  };
  migrateLegacyContinuity?(meta: Record<string, unknown>): ProviderContinuityBlob | undefined;
};

type TestArtifactRecovery = {
  finalizeFromArtifacts(options: {
    stdoutPath: string;
    stderrPath: string;
    exitCode: number | null;
    signal: string | null;
    providerMeta?: Record<string, unknown>;
    fallbackConversationRef?: string;
  }): Promise<
    | ProviderTerminalEventBody
    | {
        terminal: ProviderTerminalEventBody;
        continuity?: {
          conversationRef: string | null;
          resumable: boolean;
          providerContinuity?: ProviderContinuityBlob;
        };
      }
  >;
  buildRecoveryMeta?(request: ProviderRequest): Record<string, unknown>;
  extractProgress?(options: { stdoutPath: string; fromOffset: number; providerMeta?: Record<string, unknown> }): {
    messages: string[];
    newOffset: number;
  };
};

export type Provider = {
  readonly name: string;
  execute: TestProviderInvocation;
  preflight?(runtime: PreflightRuntime): Promise<void>;
  appServerLifecycle?: TestAppServerLifecycle;
  artifactRecovery?: TestArtifactRecovery;
  artifactCleanup?: ProviderArtifactCleanup;
};

function inferSubscriptionPhase(name: string): ProviderAppServerContract['subscriptionPhase'] {
  return name === 'claude' ? 'beforeInitialize' : 'afterInitialize';
}

function normalizeRecoveryResult(
  result: Awaited<ReturnType<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>>,
): Awaited<ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>> {
  if ('kind' in result) {
    return { terminal: result };
  }

  return result;
}

export function toProviderSpec(provider: Provider | ProviderSpec | undefined): ProviderSpec | undefined {
  if (!provider) {
    return undefined;
  }

  if ('run' in provider) {
    return provider;
  }

  const appServerLifecycle = provider.appServerLifecycle;
  const appServer = appServerLifecycle
    ? {
        name: provider.name,
        subscriptionPhase: inferSubscriptionPhase(provider.name),
        buildServerSpec: (
          request: ProviderRequest,
          persistedContinuity: ProviderContinuityBlob | undefined,
        ) =>
          appServerLifecycle.buildServerSpec(persistedContinuity, request),
        interrupt: appServerLifecycle.interrupt,
        ...(appServerLifecycle.migrateLegacyContinuity
          ? { migrateLegacyContinuity: appServerLifecycle.migrateLegacyContinuity }
          : {}),
      }
    : undefined;

  const recovery =
    provider.artifactRecovery || provider.appServerLifecycle
      ? {
          ...(provider.appServerLifecycle?.probe ? { probe: provider.appServerLifecycle.probe } : {}),
          ...(provider.appServerLifecycle?.finalizeInterrupted
            ? { finalizeInterrupted: provider.appServerLifecycle.finalizeInterrupted }
            : {}),
          finalizeFromArtifacts: (() => {
            const artifactRecovery = provider.artifactRecovery;
            return artifactRecovery
              ? async (
                  options: Parameters<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>[0],
                ) => normalizeRecoveryResult(await artifactRecovery.finalizeFromArtifacts(options))
              : async () => {
                  throw new Error(`Provider ${provider.name} does not support artifact recovery.`);
                };
          })(),
          ...(provider.artifactRecovery?.buildRecoveryMeta
            ? { buildRecoveryMeta: provider.artifactRecovery.buildRecoveryMeta }
            : {}),
          ...(provider.artifactRecovery?.extractProgress
            ? { extractProgress: provider.artifactRecovery.extractProgress }
            : {}),
        }
      : undefined;

  return {
    name: provider.name,
    run: provider.execute,
    ...(provider.preflight ? { preflight: provider.preflight } : {}),
    ...(appServer ? { appServer } : {}),
    ...(recovery ? { recovery } : {}),
    ...(provider.artifactCleanup ? { cleanup: provider.artifactCleanup } : {}),
  };
}
