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
import { buildExactProviderEnv } from '#src/providers/execution-context.js';
import { defineProvider, type ProviderDefinition } from '#src/providers/registry.js';
import type { ProviderContinuityBlob } from '#src/sessions/continuity.js';
import type { ProviderCliRequest } from '#src/providers/protocol.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import type { FixtureProviderSource } from '#tests/helpers/provider-binding.js';

const FIXTURE_ALLOWED_REQUEST_ENV_KEYS = Object.freeze(new Set(['FIXTURE_TUNING']));

type TestProviderInvocation = (
  request: ProviderRequest,
  runtime: ProviderRuntime<FixtureProviderSource>,
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
  finalizeInterrupted(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob | undefined,
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
  extractProgress?(options: { stdoutPath: string; fromOffset: number }): {
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

export function prepareFixtureExecutionContext(input: {
  source: FixtureProviderSource;
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
}): {
  readonly context: FixtureProviderSource;
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
} {
  const exactEnv = buildExactProviderEnv({
    baseEnv: input.baseEnv,
    requestEnv: input.request.coralEnv,
    protectedEnv: {
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: input.request.sessionId,
      ...(input.protectedEnv ?? {}),
    },
    routingEnv: input.source.routingEnv,
    allowedRequestKeys: FIXTURE_ALLOWED_REQUEST_ENV_KEYS,
    platform: input.platform,
  });
  return {
    context: input.source,
    prepareCliRequest: (request) => ({ ...request, exactEnv: { ...exactEnv }, extraEnv: undefined }),
  };
}

function inferSubscriptionPhase(name: string): ProviderAppServerContract<unknown>['subscriptionPhase'] {
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
  options: { binding?: Parameters<typeof fixtureProviderBindingCodec>[1] } = {},
): ProviderDefinition | undefined {
  if (!provider) {
    return undefined;
  }

  if (!('execute' in provider)) {
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
          finalizeInterrupted:
            provider.appServerLifecycle === undefined
              ? () => {
                  throw new Error(`Provider ${provider.name} has no app-server recovery capability.`);
                }
              : provider.appServerLifecycle.finalizeInterrupted,
          finalizeFromArtifacts: (() => {
            const artifactRecovery = provider.artifactRecovery;
            return artifactRecovery
              ? async (options: Parameters<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>[0]) =>
                  normalizeRecoveryResult(await artifactRecovery.finalizeFromArtifacts(options))
              : async () => {
                  throw new Error(`Provider ${provider.name} does not support artifact recovery.`);
                };
          })(),
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
    prepareExecutionContext: prepareFixtureExecutionContext,
    ...(provider.preflight ? { preflight: provider.preflight } : {}),
    ...(appServer ? { appServer } : {}),
    ...(recovery ? { recovery } : {}),
  })
    .binding(fixtureProviderBindingCodec(provider.name, options.binding))
    .artifacts(artifactCapability)
    .build();

  return definition;
}

export function toProviderDefinition(
  provider: Provider | ProviderDefinition | undefined,
): ProviderDefinition | undefined {
  return defineFakeProvider(provider);
}
