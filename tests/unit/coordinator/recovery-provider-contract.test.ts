import { describe, expect, it, vi } from 'vitest';

import { RecoveryService, type RecoveryServiceDeps } from '#src/coordinator/services/recovery/service.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderRecovery,
} from '#src/providers/bound-provider-contract.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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

const persistedHostRef = {
  provider: 'fixture',
  fingerprint: '0'.repeat(64),
  instanceId: 'instance-1',
  leaseMode: 'shared',
} as const satisfies HostRef;

const waitingRuntime = {
  transport: 'app-server',
  startTime: '2026-07-22T00:00:00.000Z',
  providerMeta: { provider: 'fixture', leaseState: 'waiting' },
} as const satisfies AppServerRuntime;

const acquiredRuntime = {
  ...waitingRuntime,
  providerMeta: { ...waitingRuntime.providerMeta, leaseState: 'acquired', hostRef: persistedHostRef },
} as const satisfies AppServerRuntime;

const session = {
  sessionId: 'session-recovery-contract',
  conversationRef: undefined,
  providerContinuity: { checkpoint: 'persisted' },
} as unknown as ProviderSession;

function recovery(): BoundProviderRecovery {
  return {
    finalizeInterrupted: (result: { resumable: boolean }) =>
      result.resumable ? { kind: 'preserve' } : { kind: 'clear_non_resumable' },
    finalizeFromArtifacts: vi.fn(),
  } as unknown as BoundProviderRecovery;
}

function managed(hostRef: HostRef) {
  return {
    hostRef,
    close: vi.fn(),
  };
}

function serviceWithCapability(appServer: BoundProviderAppServerCapability, boundRecovery = recovery()) {
  const runtime = new SimulationRuntime();
  const childPrincipalRegistry = new ChildPrincipalRegistry(runtime.ids);
  const bound = {
    name: 'fixture',
    appServer,
    recovery: boundRecovery,
  } as unknown as BoundProvider;
  const service = new RecoveryService({
    runtime,
    backendNamespace: 'test-namespace',
    childPrincipalRegistry,
    parentPrincipal: testProjectPrincipal('/project'),
    providerHostManager: { openSession: vi.fn(), attachSession: vi.fn() },
  } as unknown as RecoveryServiceDeps) as unknown as {
    decideInterruptedAppServerRecovery(options: {
      launchRecord: typeof launchRecord;
      runtimeRecord: AppServerRuntime;
      session: ProviderSession;
      bound: BoundProvider;
    }): Promise<{ mutation: { kind: string }; probeOutcome: string; recoveryConversationRef?: string }>;
  };
  return {
    decide: (runtimeRecord: AppServerRuntime, nextSession: ProviderSession = session) =>
      service.decideInterruptedAppServerRecovery({ launchRecord, runtimeRecord, session: nextSession, bound }),
    childCredentialCount: () => childPrincipalRegistry.size(),
  };
}

function capability(overrides: Partial<BoundProviderAppServerCapability> = {}): BoundProviderAppServerCapability {
  return {
    supportsInterrupt: false,
    supportsProbe: true,
    openReplacement: vi.fn(),
    interrupt: vi.fn(async () => false),
    probe: vi.fn(async () => ({ kind: 'probed' as const, result: { resumable: true } })),
    ...overrides,
  };
}

describe('interrupted provider HostRef recovery', () => {
  it('delegates waiting work without attaching or minting credentials', async () => {
    const appServer = capability();
    await expect(
      serviceWithCapability(appServer).decide(waitingRuntime, {
        ...session,
        providerContinuity: null,
      } as ProviderSession),
    ).resolves.toMatchObject({ probeOutcome: 'waiting' });
    expect(appServer.probe).not.toHaveBeenCalled();
    expect(appServer.openReplacement).not.toHaveBeenCalled();
  });

  it('probes the persisted HostRef without compiling a replacement when attachment succeeds', async () => {
    const probe = vi.fn(async () => ({ kind: 'probed' as const, result: { resumable: true } }));
    const openReplacement = vi.fn();
    const fixture = serviceWithCapability(capability({ probe, openReplacement }));
    await expect(fixture.decide(acquiredRuntime)).resolves.toMatchObject({
      probeOutcome: 'verified',
    });
    expect(probe).toHaveBeenCalledWith(
      persistedHostRef,
      session.providerContinuity,
      expect.objectContaining({
        jobId: 'job-recovery-contract',
        request: expect.objectContaining({
          action: 'exec',
          sessionId: 'session-recovery-contract',
          cwd: '/project',
        }),
      }),
    );
    expect(openReplacement).not.toHaveBeenCalled();
    expect(fixture.childCredentialCount()).toBe(0);
  });

  it('opens exactly one replacement only after a stale attachment', async () => {
    const replacementRef = { ...persistedHostRef, instanceId: 'instance-2' };
    const replacement = managed(replacementRef);
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockResolvedValueOnce({ kind: 'probed', result: { resumable: true } });
    const openReplacement = vi.fn(async (_input: unknown) => replacement);
    const fixture = serviceWithCapability(capability({ probe, openReplacement }));
    await expect(fixture.decide(acquiredRuntime)).resolves.toMatchObject({
      probeOutcome: 'verified',
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(openReplacement.mock.calls[0]?.[0]).not.toHaveProperty('protectedEnv');
    expect(fixture.childCredentialCount()).toBe(0);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports missing when its probe is non-resumable', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-non-resumable' });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockResolvedValueOnce({ kind: 'probed', result: { resumable: false } });
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'missing',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports unavailable when its attachment is stale again', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-stale' });
    const probe = vi.fn().mockResolvedValueOnce({ kind: 'stale' }).mockResolvedValueOnce({ kind: 'stale' });
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports unavailable when its probe throws', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-throwing' });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockRejectedValueOnce(new Error('replacement probe failed'));
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('classifies a provider probe failure as unavailable without opening a replacement', async () => {
    const openReplacement = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error('provider probe failed');
    });
    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
    });
    expect(openReplacement).not.toHaveBeenCalled();
  });
});
