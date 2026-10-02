import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/coordinator/live/provider-hosts/proxy-set-acquisition.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureProviderProxySet: vi.fn(),
}));
import { ensureProviderProxySet } from '#src/coordinator/live/provider-hosts/proxy-set-acquisition.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import {
  StubbedContainmentProviderHostManager,
  noCarrierBlocksRetirement,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

const mockedEnsureProxySet = vi.mocked(ensureProviderProxySet);

const proxySetAcquisition = {
  pluginRoot: '/plugin',
  identity: { instanceId: 'i', buildSetId: FIXTURE_BUILD_SET_ID, flavor: 'prod' as const },
  // This suite fakes `ensureProxySet` itself (`mockedEnsureProxySet`), so nothing here ever reads the
  // registry; empty is the honest answer regardless.
  operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
};

function createProxySetLifecycleRef(): ProviderProxySetLifecycleRef {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    claims,
    controlEstablished: () => undefined,
    time: runtime.time,
    operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(
      new InMemoryStorage(runtime.time),
      '/coral/run',
    ),
    writerIncarnation: 'pool-test',
    collectOperatorDispositionContainmentProof: async () => {
      throw new Error('unexpected durable proof collection');
    },
    reobserveAcquisitionContainment: async () => ({
      kind: 'held',
      observation: 'unknown',
      reason: 'unobserved acquisition',
    }),
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
      'capsule-redemption': () => new Promise<never>(() => undefined),
    }),
    reapRecordedContainment: () => {
      throw new Error('provider host pool fixture unexpectedly requested recorded containment reaping');
    },
    reportLifecycle: () => undefined,
  });
  lifecycle.activateDurableOperatorDispositions();
  lifecycle.initializeClaimSlots();
  lifecycle.completeStartupDiscovery();
  const ref = new ProviderProxySetLifecycleRef();
  ref.connect(lifecycle);
  return ref;
}

function expectedHost(spec: ProviderServerSpec, jobId = 'shared-attachment') {
  return { spec, jobId };
}

describe('provider host pool', () => {
  it('rejects conflicting shared-host idle policies for one executable identity', async () => {
    const server = createFakeProviderServerHandle({ generation: 10 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const hostReportedSpec = createSharedSpec();
    const lease = await manager.openSession(createLaunch(hostReportedSpec));
    const noRetirementSpec = createSharedSpec({ idleRetirement: 'never' });

    await expect(manager.openSession(createLaunch(noRetirementSpec))).rejects.toThrow('provider_host_policy_conflict');
    await expect(manager.attachSession(lease.hostRef, expectedHost(noRetirementSpec))).resolves.toBeNull();

    lease.close();
    await manager.shutdown();
  });
});

describe('provider host pool proxy set registry', () => {
  // Each manager instance is fresh per test, but the module-level `ensureProviderProxySet` mock is shared —
  // its call history must not leak from one `it` into the next.
  beforeEach(() => {
    mockedEnsureProxySet.mockReset();
  });

  it('single-flights one acquisition attempt per entry across repeated openSession calls', async () => {
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    mockedEnsureProxySet.mockImplementationOnce(
      (_entry, env: { signal: AbortSignal }, onSettled) =>
        new Promise<void>((resolve, reject) => {
          env.signal.addEventListener(
            'abort',
            () =>
              void Promise.resolve(
                onSettled({ kind: 'failed', reason: 'manager stopped', strandedArtifacts: [] }),
              ).then(resolve, reject),
            { once: true },
          );
        }),
    );

    const spec = createSharedSpec();
    const first = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    const second = await manager.openSession(createLaunch(spec), { jobId: 'job-b' });

    // Concurrent acquisition through one shared host entry must start only one attempt.
    expect(mockedEnsureProxySet).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
    await manager.shutdown();
  });
});
