import { describe, expect, it, vi } from 'vitest';

import { RecoveryService, type RecoveryServiceDeps } from '#src/coordinator/services/recovery/service.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryContract } from '#src/providers/contract.js';
import type { ProviderDefinition } from '#src/providers/registry.js';
import type { ProviderSession } from '#src/sessions/entry.js';

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

function serviceWithProvider(provider: Partial<ProviderDefinition>): InterruptedRecoveryDecisionService {
  const service = new RecoveryService({
    providerRegistry: {
      get: () => provider as ProviderDefinition,
    },
  } as unknown as RecoveryServiceDeps);
  return service as unknown as InterruptedRecoveryDecisionService;
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
  providerMeta: { provider: 'fixture', leaseState: 'waiting' },
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
    expect(finalizeInterrupted).toHaveBeenCalledWith(
      { resumable: false },
      undefined,
      { preservedConversationRef: undefined },
    );
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
