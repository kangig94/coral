import type { SessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import { none } from '#src/providers/capability.js';
import type {
  PreflightRuntime,
  ProviderAppServerCapability,
  ProviderArtifactCapability,
  ProviderArtifactHandleInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderAppServer,
  ProviderStandalone,
  AppServerTransport,
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
import type { FixtureProviderAccess } from '#tests/helpers/provider-binding.js';

const FIXTURE_ALLOWED_REQUEST_ENV_KEYS = Object.freeze(new Set(['FIXTURE_TUNING']));

export type FixtureExecutionPlan = ProviderExecutionPlan<
  Readonly<{
    access: FixtureProviderAccess;
    platform: string;
    environment: readonly EnvironmentLayer[];
    serverSpec: ProviderServerSpec;
  }>,
  Readonly<{ sessionId: string }>,
  Readonly<{ environment: readonly EnvironmentLayer[] }>
>;

type TestAppServerLifecycle = {
  host:
    | ProviderServerSpec
    | ((persistedContinuity: ProviderContinuityBlob | undefined, request: ProviderRequest) => ProviderServerSpec);
  interrupt(lease: AppServerTransport, continuity: ProviderContinuityBlob): Promise<void>;
  probe?(
    lease: AppServerTransport,
    continuity: ProviderContinuityBlob,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  onNotification?(message: { method: string; params?: Record<string, unknown> }): void;
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

type ProviderCommon = {
  readonly name: string;
  preflight?(runtime: PreflightRuntime): Promise<void>;
  artifactRecovery?: TestArtifactRecovery;
  artifactCapability?: ProviderArtifactCapability;
};

export type Provider =
  | (ProviderCommon & {
      execute: ProviderStandalone<FixtureExecutionPlan>;
      appServerLifecycle?: undefined;
    })
  | (ProviderCommon & {
      execute: ProviderAppServer<FixtureExecutionPlan>;
      appServerLifecycle: TestAppServerLifecycle;
    });

export type StandaloneTestProvider = Extract<Provider, { appServerLifecycle?: undefined }>;
export type AppServerTestProvider = Extract<Provider, { appServerLifecycle: TestAppServerLifecycle }>;

export function prepareFixtureAppServerExecutionPlan(input: {
  access: FixtureProviderAccess;
  hostPlan: FixtureExecutionPlan['host'];
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  persistedContinuity?: ProviderContinuityBlob;
}): {
  readonly session: FixtureExecutionPlan['session'];
  readonly turn: FixtureExecutionPlan['turn'];
} {
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
  const session = Object.freeze({ sessionId: input.request.sessionId });
  const turn = Object.freeze({ environment: Object.freeze(turnEnvironment) });
  return {
    session,
    turn,
  };
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
        planHost: (
          input: Parameters<ProviderAppServerCapability<FixtureExecutionPlan, FixtureProviderAccess>['planHost']>[0],
        ) => {
          if (input.purpose !== 'execution') throw new Error('Fixture provider does not support curation hosts.');
          const host =
            typeof appServerLifecycle.host === 'function'
              ? appServerLifecycle.host(input.persistedContinuity, input.request)
              : appServerLifecycle.host;
          const preparedHost = prepareFixtureHost(input, host);
          return preparedHost;
        },
        compileStableHost: (host: FixtureExecutionPlan['host']) => host.serverSpec,
        interrupt: async (transport: AppServerTransport, continuity: ProviderContinuityBlob) => {
          await appServerLifecycle.interrupt(transport, continuity);
          return true;
        },
        ...(appServerLifecycle.probe === undefined ? {} : { probe: appServerLifecycle.probe }),
        ...(appServerLifecycle.onNotification === undefined
          ? {}
          : { onNotification: appServerLifecycle.onNotification }),
      }
    : undefined;

  const recovery =
    provider.artifactRecovery || provider.appServerLifecycle
      ? {
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
  const common = {
    name: provider.name,
    ...(provider.preflight ? { preflight: provider.preflight } : {}),
    ...(recovery ? { recovery } : {}),
  };
  const builder =
    provider.appServerLifecycle === undefined
      ? defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
          ...common,
          transport: 'standalone',
          run: provider.execute,
          prepareExecutionPlan: (input) => prepareFixtureExecutionPlan(input),
        })
      : defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
          ...common,
          transport: 'app-server',
          run: provider.execute,
          appServer: appServer!,
          prepareExecutionPlan: (input) => prepareFixtureAppServerExecutionPlan(input),
        });
  const definition = builder
    .binding(fixtureProviderBindingCodec(provider.name, options.binding))
    .artifacts(artifactCapability)
    .build();

  return definition;
}

export function prepareFixtureExecutionPlan(
  input: Omit<Parameters<typeof prepareFixtureAppServerExecutionPlan>[0], 'hostPlan'> & {
    storage: Pick<ProviderRuntime['storage'], 'existsSync'>;
  },
) {
  const serverSpec: ProviderServerSpec = {
    provider: 'fixture',
    command: 'fixture',
    args: ['app-server'],
    cwd: input.request.cwd,
    leaseMode: 'job-exclusive',
  };
  const host = prepareFixtureHost({ ...input, purpose: 'execution' }, serverSpec);
  const prepared = prepareFixtureAppServerExecutionPlan({ ...input, hostPlan: host });
  const exactEnv = compileEnvironmentLayers([...host.environment, ...prepared.turn.environment], {
    platform: input.platform,
    lifetimes: allExecutionLifetimes(),
  });
  return {
    plan: Object.freeze({ host, session: prepared.session, turn: prepared.turn }),
    prepareCliRequest: (request: ProviderCliRequest) => ({
      ...request,
      exactEnv: { ...exactEnv },
      extraEnv: undefined,
    }),
  };
}

export function prepareFixtureHost(
  input: Parameters<ProviderAppServerCapability<FixtureExecutionPlan, FixtureProviderAccess>['planHost']>[0],
  serverSpec: ProviderServerSpec,
): FixtureExecutionPlan['host'] {
  const environment = Object.freeze([
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
        values: input.access.routingEnv,
        writes: new Set(Object.keys(input.access.routingEnv)),
        protects: new Set(Object.keys(input.access.routingEnv)),
      },
      input.platform,
    ),
    environmentLayer(
      {
        name: 'fixture-process-settings',
        lifetime: 'host',
        provenance: 'test-request-process',
        values: filterEnvironmentValues(
          input.purpose === 'execution' ? input.request.coralEnv : {},
          new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
          input.platform,
        ),
        writes: new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]),
        protects: new Set(),
      },
      input.platform,
    ),
  ]);
  const compiledSpec = Object.freeze({
    ...serverSpec,
    env: compileEnvironmentLayers(environment, {
      platform: input.platform,
      lifetimes: new Set(['host']),
    }),
  });
  return Object.freeze({ access: input.access, platform: input.platform, environment, serverSpec: compiledSpec });
}

export function toProviderDefinition(
  provider: Provider | ProviderDefinition | undefined,
): ProviderDefinition | undefined {
  return defineFakeProvider(provider);
}
