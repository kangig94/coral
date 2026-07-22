import type { SessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import { none } from '#src/providers/capability.js';
import type {
  PreflightRuntime,
  ProviderAppServerCapability,
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
import {
  allExecutionLifetimes,
  compileEnvironmentLayers,
  CORAL_PROCESS_ENV_KEYS,
  CORAL_TURN_ENV_KEYS,
  environmentLayer,
  EXECUTION_ENV_ALLOWLIST,
  filterEnvironmentValues,
  type EnvironmentLayer,
  type ProviderExecutionPlan,
} from '#src/providers/execution-plan.js';
import { defineProvider, type ProviderDefinition } from '#src/providers/registry.js';
import type { ProviderContinuityBlob } from '#src/sessions/continuity.js';
import type { ProviderCliRequest } from '#src/providers/protocol.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import type { FixtureProviderSource } from '#tests/helpers/provider-binding.js';

const FIXTURE_ALLOWED_REQUEST_ENV_KEYS = Object.freeze(new Set(['FIXTURE_TUNING']));

type TestProviderInvocation = (
  request: ProviderRequest,
  runtime: ProviderRuntime<FixtureExecutionPlan>,
) => AsyncIterable<ProviderEventBody>;

export type FixtureExecutionPlan = ProviderExecutionPlan<
  Readonly<{
    source: FixtureProviderSource;
    platform: string;
    environment: readonly EnvironmentLayer[];
    serverSpec: ProviderServerSpec;
  }>,
  Readonly<{ sessionId: string }>,
  Readonly<{ environment: readonly EnvironmentLayer[] }>
>;

type TestAppServerLifecycle = {
  prepareHostSpec(
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

export function prepareFixtureExecutionPlan(input: {
  source: FixtureProviderSource;
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  persistedContinuity?: ProviderContinuityBlob;
}): {
  readonly plan: FixtureExecutionPlan;
  readonly appServerTurnEnv: Readonly<Record<string, string>>;
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
} {
  const hostEnvironment = [
    environmentLayer(
      {
        name: 'daemon-base',
        lifetime: 'host',
        provenance: 'test-runtime',
        values: filterEnvironmentValues(input.baseEnv, EXECUTION_ENV_ALLOWLIST, input.platform),
        writes: EXECUTION_ENV_ALLOWLIST,
        protects: new Set(),
      },
      input.platform,
    ),
    environmentLayer(
      {
        name: 'fixture-routing',
        lifetime: 'host',
        provenance: 'fixture-binding',
        values: input.source.routingEnv,
        writes: new Set(Object.keys(input.source.routingEnv)),
        protects: new Set(Object.keys(input.source.routingEnv)),
      },
      input.platform,
    ),
    environmentLayer(
      {
        name: 'fixture-process-settings',
        lifetime: 'host',
        provenance: 'test-request-process',
        values: filterEnvironmentValues(
          input.request.coralEnv,
          new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
          input.platform,
        ),
        writes: new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
        protects: new Set(),
      },
      input.platform,
    ),
  ];
  const authority = { CORAL_CHILD: '1', CORAL_SESSION_ID: input.request.sessionId, ...(input.protectedEnv ?? {}) };
  const turnEnvironment = [
    environmentLayer(
      {
        name: 'fixture-turn-authority',
        lifetime: 'turn',
        provenance: 'test-principal',
        values: authority,
        writes: new Set(Object.keys(authority)),
        protects: new Set(Object.keys(authority)),
      },
      input.platform,
    ),
    environmentLayer(
      {
        name: 'fixture-turn-request',
        lifetime: 'turn',
        provenance: 'test-request',
        values: filterEnvironmentValues(
          input.request.coralEnv,
          new Set([...CORAL_TURN_ENV_KEYS, ...FIXTURE_ALLOWED_REQUEST_ENV_KEYS]),
          input.platform,
        ),
        writes: new Set([...CORAL_TURN_ENV_KEYS, ...FIXTURE_ALLOWED_REQUEST_ENV_KEYS]),
        protects: new Set(),
      },
      input.platform,
    ),
  ];
  const serverSpec: ProviderServerSpec = {
    provider: 'fixture',
    command: 'fixture',
    args: ['app-server'],
    cwd: input.request.cwd,
    env: compileEnvironmentLayers(hostEnvironment, {
      platform: input.platform,
      lifetimes: new Set(['host']),
    }),
    leaseMode: 'job-exclusive',
  };
  const plan: FixtureExecutionPlan = Object.freeze({
    host: Object.freeze({
      source: input.source,
      platform: input.platform,
      environment: Object.freeze(hostEnvironment),
      serverSpec,
    }),
    session: Object.freeze({ sessionId: input.request.sessionId }),
    turn: Object.freeze({ environment: Object.freeze(turnEnvironment) }),
  });
  const exactEnv = compileEnvironmentLayers([...hostEnvironment, ...turnEnvironment], {
    platform: input.platform,
    lifetimes: allExecutionLifetimes(),
  });
  const turnEnv = compileEnvironmentLayers(turnEnvironment, {
    platform: input.platform,
    lifetimes: new Set(['turn']),
  });
  return {
    plan,
    appServerTurnEnv: turnEnv,
    prepareCliRequest: (request) => ({ ...request, exactEnv: { ...exactEnv }, extraEnv: undefined }),
  };
}

function inferSubscriptionPhase(name: string): ProviderAppServerCapability<FixtureExecutionPlan>['subscriptionPhase'] {
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
        compileStableHost: (host: FixtureExecutionPlan['host']) => host.serverSpec,
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
  const definition = defineProvider<FixtureExecutionPlan, FixtureProviderSource>({
    name: provider.name,
    run: provider.execute,
    prepareExecutionPlan: (input) => {
      const prepared = prepareFixtureExecutionPlan(input);
      if (appServerLifecycle === undefined) return prepared;
      const host = appServerLifecycle.prepareHostSpec(input.persistedContinuity, input.request);
      return {
        ...prepared,
        plan: Object.freeze({
          ...prepared.plan,
          host: Object.freeze({ ...prepared.plan.host, serverSpec: host }),
        }),
        appServerTurnEnv: prepared.appServerTurnEnv,
      };
    },
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
