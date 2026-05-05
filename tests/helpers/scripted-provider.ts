import type { SessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import { none } from '#src/providers/capability.js';
import type {
  PreflightRuntime,
  ProviderAppServerContract,
  ProviderArtifactCapability,
  ProviderArtifactHandleInput,
  ProviderEventBody,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
  ProviderTerminalEventBody,
} from '#src/providers/contract.js';
import { defineProvider, type ProviderDefinition } from '#src/providers/define.js';
import type { ProviderContinuityBlob } from '#src/sessions/continuity.js';

type TestProviderInvocation = (request: ProviderRequest, runtime: ProviderRuntime) => AsyncIterable<ProviderEventBody>;

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
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation;
};

type TestArtifactRecovery = {
  finalizeFromArtifacts(options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0]): Promise<
    | ProviderTerminalEventBody
    | {
        terminal: ProviderTerminalEventBody;
        continuity?: {
          conversationRef: string | null;
          resumable: boolean;
          providerContinuity?: ProviderContinuityBlob;
        };
        artifactHandles?: readonly ProviderArtifactHandleInput[];
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
  artifactCapability?: ProviderArtifactCapability;
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

export function defineFakeProvider(
  provider: Provider | ProviderDefinition | undefined,
): ProviderDefinition | undefined {
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
        buildServerSpec: (request: ProviderRequest, persistedContinuity: ProviderContinuityBlob | undefined) =>
          appServerLifecycle.buildServerSpec(persistedContinuity, request),
        interrupt: appServerLifecycle.interrupt,
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
              ? async (options: Parameters<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>[0]) =>
                  normalizeRecoveryResult(await artifactRecovery.finalizeFromArtifacts(options))
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

  const artifactCapability =
    provider.artifactCapability ?? none(`Test provider ${provider.name} declares no provider artifacts.`);
  const definition = defineProvider({
    name: provider.name,
    run: provider.execute,
    ...(provider.preflight ? { preflight: provider.preflight } : {}),
    ...(appServer ? { appServer } : {}),
    ...(recovery ? { recovery } : {}),
  })
    .artifacts(artifactCapability)
    .build();

  return definition;
}

export function toProviderSpec(provider: Provider | ProviderDefinition | undefined): ProviderDefinition | undefined {
  return defineFakeProvider(provider);
}
