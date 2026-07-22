import { describe, expect, it, vi } from 'vitest';

import { RecoveryService, type RecoveryServiceDeps } from '#src/coordinator/services/recovery/service.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryContract, ProviderServerLaunch, ProviderServerLease } from '#src/providers/contract.js';
import type { BoundProvider, BoundProviderPreparedExecution } from '#src/providers/bound-provider-contract.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { ProviderCliRequest } from '#src/providers/protocol.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { createDeferred } from '#tools/testing/deferred.js';

type InterruptedRecoveryDecision = {
  mutation: { kind: string };
  probeOutcome: string;
  recoveryConversationRef: string | undefined;
};

type InterruptedRecoveryDecisionService = {
  decideInterruptedAppServerRecovery(options: {
    launchRecord: JobLaunch & { sessionId: string; provider: string };
    runtimeRecord: AppServerRuntime;
    session: ProviderSession;
    source: never;
  }): Promise<InterruptedRecoveryDecision>;
};

type TestBoundCapabilities = {
  readonly appServer?: BoundProviderPreparedExecution['appServer'];
  readonly recovery?: ProviderRecoveryContract;
};

function serviceWithProvider(
  provider: TestBoundCapabilities,
  options: {
    deps?: Partial<RecoveryServiceDeps>;
    prepareExecution?: ReturnType<typeof vi.fn>;
    prepareStableHost?: ReturnType<typeof vi.fn>;
  } = {},
): InterruptedRecoveryDecisionService {
  const runtime = new SimulationRuntime();
  const bound = {
    name: 'fixture',
    prepareExecution:
      options.prepareExecution ??
      (() => ({
        prepareCliRequest: (request: ProviderCliRequest) => request,
        execute: async function* () {},
        ...(provider.appServer === undefined ? {} : { appServer: provider.appServer }),
      })),
    ...(provider.appServer === undefined
      ? {}
      : {
          appServer: {
            name: provider.appServer.name,
            subscriptionPhase: provider.appServer.subscriptionPhase,
            prepareStableHost: options.prepareStableHost ?? (() => ({ host: provider.appServer?.launch.host })),
            ...(provider.appServer.interrupt === undefined ? {} : { interrupt: provider.appServer.interrupt }),
          },
        }),
    ...(provider.recovery === undefined ? {} : { recovery: provider.recovery }),
  } as unknown as BoundProvider;
  const service = new RecoveryService({
    runtime,
    backendNamespace: 'test-namespace',
    childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
    parentPrincipal: testProjectPrincipal('/project'),
    ...options.deps,
  } as unknown as RecoveryServiceDeps) as unknown as {
    decideInterruptedAppServerRecovery(options: {
      launchRecord: JobLaunch & { sessionId: string; provider: string };
      runtimeRecord: AppServerRuntime;
      session: ProviderSession;
      bound: BoundProvider;
    }): Promise<InterruptedRecoveryDecision>;
  };
  return {
    decideInterruptedAppServerRecovery: (options) =>
      service.decideInterruptedAppServerRecovery({
        launchRecord: options.launchRecord,
        runtimeRecord: options.runtimeRecord,
        session: options.session,
        bound,
      }),
  };
}

const launchRecord = {
  jobId: 'job-recovery-contract',
  owner: { kind: 'provider-session', id: 'session-recovery-contract' },
  sessionId: 'session-recovery-contract',
  provider: 'fixture',
  projectRoot: '/project',
  backendNamespace: 'namespace',
  jobKind: 'provider',
  pool: 'default',
  enqueueSequence: 1,
  providerAction: 'exec',
  request: { prompt: 'test', cwd: '/project', bypassPermissions: false, coralEnv: {} },
  createdAt: '2026-07-22T00:00:00.000Z',
} as const satisfies JobLaunch;

const runtimeRecord = {
  transport: 'app-server',
  startTime: '2026-07-22T00:00:00.000Z',
  providerMeta: { provider: 'fixture', leaseState: 'waiting', transportMode: 'fixture-wire' },
} as const satisfies AppServerRuntime;

const session = {
  sessionId: 'session-recovery-contract',
  conversationRef: undefined,
  providerContinuity: null,
} as unknown as ProviderSession;

describe('interrupted provider recovery contract', () => {
  it('delegates a pre-checkpoint interruption to the provider without a coordinator fallback', async () => {
    const finalizeInterrupted = vi.fn(() => ({ kind: 'preserve' as const }));
    const recovery = {
      finalizeInterrupted,
      finalizeFromArtifacts: vi.fn(),
    } as unknown as ProviderRecoveryContract;
    const service = serviceWithProvider({
      appServer: {
        name: 'fixture',
        subscriptionPhase: 'afterInitialize',
        launch: {
          host: { provider: 'fixture', command: 'fixture', args: [], cwd: '/project', leaseMode: 'job-exclusive' },
          turnEnv: {},
        },
      },
      recovery,
    });

    await expect(
      service.decideInterruptedAppServerRecovery({
        launchRecord,
        runtimeRecord,
        session,
        source: undefined as never,
      }),
    ).resolves.toEqual({
      mutation: { kind: 'preserve' },
      probeOutcome: 'waiting',
      recoveryConversationRef: undefined,
    });
    expect(finalizeInterrupted).toHaveBeenCalledWith({ resumable: false }, undefined, {
      preservedConversationRef: undefined,
    });
  });

  it('fails closed when persisted app-server work has no recovery capability', async () => {
    const service = serviceWithProvider({
      appServer: {
        name: 'fixture',
        subscriptionPhase: 'afterInitialize',
        launch: {
          host: { provider: 'fixture', command: 'fixture', args: [], cwd: '/project', leaseMode: 'job-exclusive' },
          turnEnv: {},
        },
      },
    });

    await expect(
      service.decideInterruptedAppServerRecovery({
        launchRecord,
        runtimeRecord,
        session,
        source: undefined as never,
      }),
    ).rejects.toThrow("Provider 'fixture' has no interrupted app-server recovery capability.");
  });

  it('probes an acquired attached host without minting replacement turn credentials', async () => {
    const register = vi.spyOn(ChildPrincipalRegistry.prototype, 'register');
    const borrowLiveServer = vi.fn(async () => ({
      rpc: vi.fn(async () => ({})),
      subscribe: vi.fn(() => () => {}),
      closed: Promise.resolve(),
    }));
    const probe = vi.fn(async () => ({ resumable: true, updatedContinuity: { checkpoint: 'verified' } }));
    const finalizeInterrupted = vi.fn(() => ({ kind: 'preserve' as const }));
    const launch = {
      host: {
        provider: 'fixture',
        command: 'fixture',
        args: [],
        cwd: '/project',
        leaseMode: 'job-exclusive' as const,
      },
      turnEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'attachment-plan-has-no-live-credential' },
    };
    const prepareExecution = vi.fn((_input: Parameters<BoundProvider['prepareExecution']>[0]) => ({
      prepareCliRequest: (request: ProviderCliRequest) => request,
      execute: async function* () {},
      appServer: { name: 'fixture', subscriptionPhase: 'afterInitialize' as const, launch },
    }));
    const prepareStableHost = vi.fn((_input: unknown) => ({ host: launch.host }));
    const service = serviceWithProvider(
      {
        appServer: { name: 'fixture', subscriptionPhase: 'afterInitialize', launch },
        recovery: { probe, finalizeInterrupted, finalizeFromArtifacts: vi.fn() } as unknown as ProviderRecoveryContract,
      },
      {
        prepareExecution,
        prepareStableHost,
        deps: { providerHostManager: { borrowLiveServer } as never },
      },
    );

    await expect(
      service.decideInterruptedAppServerRecovery({
        launchRecord,
        runtimeRecord: {
          ...runtimeRecord,
          providerMeta: { ...runtimeRecord.providerMeta, leaseState: 'acquired', serverGeneration: 17 },
        },
        session: {
          ...session,
          providerContinuity: { checkpoint: 'persisted' },
        } as unknown as ProviderSession,
        source: undefined as never,
      }),
    ).resolves.toMatchObject({ probeOutcome: 'verified', mutation: { kind: 'preserve' } });

    expect(borrowLiveServer).toHaveBeenCalledWith(launch.host, {
      serverGeneration: 17,
      jobId: launchRecord.jobId,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(prepareStableHost).toHaveBeenCalledTimes(1);
    expect(prepareStableHost.mock.calls[0]?.[0]).not.toHaveProperty('protectedEnv');
    expect(prepareExecution).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('mints one replacement credential only after attachment fails and keeps it out of stable host identity', async () => {
    const register = vi.spyOn(ChildPrincipalRegistry.prototype, 'register');
    const stableHost = {
      provider: 'fixture',
      command: 'fixture',
      args: [],
      cwd: '/project',
      env: { FIXTURE_ACCOUNT: '/accounts/a' },
      leaseMode: 'job-exclusive' as const,
    };
    const borrowLiveServer = vi.fn(async () => null);
    const replacementRelease = vi.fn();
    const acquireServer = vi.fn(
      async (
        _launch: ProviderServerLaunch,
        _options?: { jobId?: string; signal?: AbortSignal },
      ): Promise<ProviderServerLease> => ({
        rpc: async <R>() => ({}) as R,
        subscribe: vi.fn(() => () => {}),
        release: replacementRelease,
        closed: Promise.resolve(),
        generation: 23,
      }),
    );
    const probe = vi.fn(async () => ({ resumable: true, updatedContinuity: { checkpoint: 'replacement' } }));
    const finalizeInterrupted = vi.fn(() => ({ kind: 'preserve' as const }));
    const prepareStableHost = vi.fn((_input: unknown) => ({ host: stableHost }));
    const prepareExecution = vi.fn((input: Parameters<BoundProvider['prepareExecution']>[0]) => ({
      prepareCliRequest: (request: ProviderCliRequest) => request,
      execute: async function* () {},
      appServer: {
        name: 'fixture',
        subscriptionPhase: 'afterInitialize' as const,
        launch: { host: stableHost, turnEnv: input.protectedEnv ?? {} },
      },
    }));
    const service = serviceWithProvider(
      {
        appServer: {
          name: 'fixture',
          subscriptionPhase: 'afterInitialize',
          launch: { host: stableHost, turnEnv: {} },
        },
        recovery: { probe, finalizeInterrupted, finalizeFromArtifacts: vi.fn() } as unknown as ProviderRecoveryContract,
      },
      {
        prepareExecution,
        prepareStableHost,
        deps: {
          providerHostManager: { borrowLiveServer } as never,
          acquireServer,
        },
      },
    );

    await expect(
      service.decideInterruptedAppServerRecovery({
        launchRecord,
        runtimeRecord: {
          ...runtimeRecord,
          providerMeta: { ...runtimeRecord.providerMeta, leaseState: 'acquired', serverGeneration: 22 },
        },
        session: {
          ...session,
          providerContinuity: { checkpoint: 'persisted' },
        } as unknown as ProviderSession,
        source: undefined as never,
      }),
    ).resolves.toMatchObject({ probeOutcome: 'verified', mutation: { kind: 'preserve' } });

    expect(prepareStableHost).toHaveBeenCalledTimes(1);
    expect(prepareExecution).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(acquireServer).toHaveBeenCalledTimes(1);
    const replacementLaunch = acquireServer.mock.calls[0]?.[0];
    const mintedHandle = register.mock.results[0]?.value.handle;
    expect(replacementLaunch?.turnEnv).toMatchObject({ CORAL_CHILD_PRINCIPAL_HANDLE: mintedHandle });
    expect(replacementLaunch?.host.env).toEqual({ FIXTURE_ACCOUNT: '/accounts/a' });
    expect(replacementLaunch?.host.env).not.toHaveProperty('CORAL_CHILD_PRINCIPAL_HANDLE');
    expect(acquireServer).toHaveBeenCalledWith(replacementLaunch, { jobId: launchRecord.jobId });
    expect(replacementRelease).toHaveBeenCalledTimes(1);
  });

  it.each(['non-resumable', 'error'] as const)(
    'releases a temporary replacement lease after a %s probe outcome',
    async (outcome) => {
      const events: string[] = [];
      const stableHost = {
        provider: 'fixture',
        command: 'fixture',
        args: [],
        cwd: '/project',
        leaseMode: 'job-exclusive' as const,
      };
      const release = vi.fn(() => events.push('release'));
      const acquireServer = vi.fn(
        async (
          _launch: ProviderServerLaunch,
          _options?: { jobId?: string; signal?: AbortSignal },
        ): Promise<ProviderServerLease> => ({
          rpc: async <R>() => ({}) as R,
          subscribe: vi.fn(() => () => {}),
          release,
          closed: Promise.resolve(),
          generation: 24,
        }),
      );
      const probeCompletion = createDeferred<{
        resumable: boolean;
        updatedContinuity: { checkpoint: string };
      }>();
      const probe = vi.fn(async () => {
        events.push('probe');
        return probeCompletion.promise;
      });
      const finalizeInterrupted = vi.fn(() => {
        events.push('finalize');
        return { kind: 'clear_non_resumable' as const };
      });
      const prepareExecution = vi.fn(() => ({
        prepareCliRequest: (request: ProviderCliRequest) => request,
        execute: async function* () {},
        appServer: {
          name: 'fixture',
          subscriptionPhase: 'afterInitialize' as const,
          launch: { host: stableHost, turnEnv: {} },
        },
      }));
      const service = serviceWithProvider(
        {
          appServer: {
            name: 'fixture',
            subscriptionPhase: 'afterInitialize',
            launch: { host: stableHost, turnEnv: {} },
          },
          recovery: {
            probe,
            finalizeInterrupted,
            finalizeFromArtifacts: vi.fn(),
          } as unknown as ProviderRecoveryContract,
        },
        {
          prepareExecution,
          prepareStableHost: vi.fn(() => ({ host: stableHost })),
          deps: {
            providerHostManager: { borrowLiveServer: vi.fn(async () => null) } as never,
            acquireServer,
          },
        },
      );

      const decision = service.decideInterruptedAppServerRecovery({
        launchRecord,
        runtimeRecord: {
          ...runtimeRecord,
          providerMeta: { ...runtimeRecord.providerMeta, leaseState: 'acquired', serverGeneration: 22 },
        },
        session: {
          ...session,
          providerContinuity: { checkpoint: 'persisted' },
        } as unknown as ProviderSession,
        source: undefined as never,
      });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      expect(release).not.toHaveBeenCalled();
      if (outcome === 'error') {
        probeCompletion.reject(new Error('probe exploded'));
      } else {
        probeCompletion.resolve({ resumable: false, updatedContinuity: { checkpoint: 'not-resumable' } });
      }
      await expect(decision).resolves.toMatchObject({
        probeOutcome: outcome === 'error' ? 'unavailable' : 'missing',
        mutation: { kind: 'clear_non_resumable' },
      });

      expect(acquireServer).toHaveBeenCalledWith(expect.anything(), { jobId: launchRecord.jobId });
      expect(release).toHaveBeenCalledTimes(1);
      expect(events[0]).toBe('probe');
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('probe'));
    },
  );
});
