import { describe, expect, it, vi } from 'vitest';

import { RecoveryService, type RecoveryServiceDeps } from '#src/coordinator/services/recovery/service.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryContract } from '#src/providers/contract.js';
import type { BoundProvider, BoundProviderPreparedExecution } from '#src/providers/bound-provider-contract.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { ProviderCliRequest } from '#src/providers/protocol.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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

function serviceWithProvider(provider: TestBoundCapabilities): InterruptedRecoveryDecisionService {
  const runtime = new SimulationRuntime();
  const bound = {
    name: 'fixture',
    prepareExecution: () => ({
      prepareCliRequest: (request: ProviderCliRequest) => request,
      execute: async function* () {},
      ...(provider.appServer === undefined ? {} : { appServer: provider.appServer }),
    }),
    ...(provider.recovery === undefined ? {} : { recovery: provider.recovery }),
  } as unknown as BoundProvider;
  const service = new RecoveryService({
    runtime,
    backendNamespace: 'test-namespace',
    childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
    parentPrincipal: testProjectPrincipal('/project'),
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
        buildServerSpec: vi.fn(),
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
        buildServerSpec: vi.fn(),
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
});
