import {
  authorizeProviderProxySetContainmentProof,
  providerProxySetContainmentProofForTest,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDeferred } from '#tools/testing/deferred.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

// `ensureProxySetFor` (the manager's own dedup/registry wiring) is what these tests exercise; the acquisition
// attempt it delegates to is already covered end to end by `proxy-set-acquisition.test.ts` and the real-spawn
// integration test, so stubbing it here keeps this suite free of process spawning.
vi.mock('#src/coordinator/live/provider-hosts/proxy-set-acquisition.js', () => ({
  ensureProviderProxySet: vi.fn(),
}));

import { hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/state.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import { MAX_COORDINATOR_PROXY_SET_SLOTS } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ensureProviderProxySet } from '#src/coordinator/live/provider-hosts/proxy-set-acquisition.js';
import type { ProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/authority.js';
import type {
  DurableProviderProxyOperationAuthority,
  ProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { HostRef, ProviderServerSpec } from '#src/providers/contract.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import {
  StubbedContainmentProviderHostManager,
  noCarrierBlocksRetirement,
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

const mockedEnsureProxySet = ensureProviderProxySet as unknown as ReturnType<typeof vi.fn>;

function fakeProxySet(proxyInstanceId: string): ProviderProxySetAuthority {
  return {
    proxyInstanceId: /^[0-9a-f]{8}-/u.test(proxyInstanceId) ? proxyInstanceId : randomUUID(),
    stopAndReap: async () => ({ disappearanceReceipt: 'r' }),
    stopHeartbeats: () => {},
    initiateControlClose: async () => {},
  };
}

/** `registerInheritedSet` takes the full operation-routing authority, unlike `ensureProxySetFor`'s untyped
 *  mock elsewhere in this file — a fresh fixture rather than widening `fakeProxySet` for every caller. */
function fakeInheritedProxySet(proxyInstanceId: string): ProviderProxyOperationAuthority {
  const base = fakeProxySet(proxyInstanceId);
  return {
    ...base,
    autonomousDeadline: {
      orphanTimeoutMs: Number.MAX_SAFE_INTEGER,
      adoptionWindowMs: Number.MAX_SAFE_INTEGER,
      heartbeatHoldBound: {
        spanMs: Number.MAX_SAFE_INTEGER,
        materialSchedulerLatenessMs: Number.MAX_SAFE_INTEGER,
      },
    },
    registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    setIdentity: {
      buildSetId: randomUUID(),
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: randomUUID(),
      guardianPid: 100,
      guardianIncarnation: testIncarnation(1),
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId: base.proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: randomUUID(),
      reaperPid: 300,
      reaperIncarnation: testIncarnation(2),
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'posix-group',
      proxyIncarnation: testIncarnation(3),
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
  };
}

function fakeDurableProxySet(
  proxyInstanceId: string,
  options: {
    prepareOperation?: DurableProviderProxyOperationAuthority['prepareOperation'];
    stopAndReap?: DurableProviderProxyOperationAuthority['stopAndReap'];
    stopHeartbeats?: DurableProviderProxyOperationAuthority['stopHeartbeats'];
    initiateControlClose?: DurableProviderProxyOperationAuthority['initiateControlClose'];
  } = {},
): DurableProviderProxyOperationAuthority {
  const inherited = fakeInheritedProxySet(proxyInstanceId);
  return {
    ...inherited,
    faulted: new Promise<never>(() => {}),
    onFault: () => () => undefined,
    onIncident: () => () => undefined,
    redeemControl: () => new Promise<never>(() => undefined),
    promoteControl: async () => {
      throw new Error('unused');
    },
    prepareOperation:
      options.prepareOperation ??
      (async () => {
        throw new Error('unused prepareOperation');
      }),
    inspectOperation: async () => {
      throw new Error('unused inspectOperation');
    },
    authorizeOperation: async () => {
      throw new Error('unused authorizeOperation');
    },
    activatePreparedOperation: async () => {
      throw new Error('unused activatePreparedOperation');
    },
    attachOperation: async () => {
      throw new Error('unused attachOperation');
    },
    cancelOperation: async () => {
      throw new Error('unused cancelOperation');
    },
    settleOperation: async () => {
      throw new Error('unused settleOperation');
    },
    buildOperationControl: () => ({ stop: async () => {} }),
    stopAndReap: options.stopAndReap ?? inherited.stopAndReap,
    stopHeartbeats: options.stopHeartbeats ?? inherited.stopHeartbeats,
    initiateControlClose: options.initiateControlClose ?? inherited.initiateControlClose,
  };
}

const proxySetAcquisition = {
  pluginRoot: '/plugin',
  identity: { instanceId: 'i', buildSetId: 'b', flavor: 'prod' as const },
  // This suite fakes `ensureProxySet` itself (`mockedEnsureProxySet`), so nothing here ever reads the
  // registry; empty is the honest answer regardless.
  operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
};

function createProxySetLifecycleRef(onSlotReleased?: (routeKey: string) => void): ProviderProxySetLifecycleRef {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize([]);
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    claims,
    controlEstablished: () => undefined,
    time: runtime.time,
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
      'containment-proof': async ({ identity }) =>
        providerProxySetContainmentProofForTest(authorizeProviderProxySetContainmentProof(identity), {
          kind: 'enforcers-observed' as const,
          observations: [
            { role: 'guardian', observation: 'unknown' },
            { role: 'reaper', observation: 'unknown' },
          ] as const,
        }),
    }),
    reapRecordedContainment: () => {
      throw new Error('provider host pool fixture unexpectedly requested recorded containment reaping');
    },
    reportLifecycle: () => undefined,
    ...(onSlotReleased === undefined ? {} : { onSlotReleased }),
  });
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
  it.each([
    [{ ...createSharedSpec(), idleRetirement: undefined }, 'shared hosts require idleRetirement'],
    [{ ...createSharedSpec(), idleRetirement: 'implicit-timeout' }, 'shared hosts require idleRetirement'],
    [{ ...createExclusiveSpec(), idleRetirement: 'never' }, 'job-exclusive hosts cannot declare idleRetirement'],
    [{ ...createExclusiveSpec(), leaseMode: 'unknown' }, "leaseMode must be 'shared' or 'job-exclusive'"],
  ])('rejects malformed runtime lifecycle policy before spawning', async (spec, expected) => {
    const server = createFakeProviderServerHandle();
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });

    await expect(manager.openSession(spec as never, { jobId: 'job-a' })).rejects.toThrow(expected);
    expect(spawnProviderServer).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it('hostKeyFromSpec normalizes env ordering and separates incompatible hosts', () => {
    const base = createExclusiveSpec({ args: ['app-server'], cwd: fixtureCanonicalWorkDir('/workspace/a') });

    expect(hostKeyFromSpec(base)).toBe(
      hostKeyFromSpec({
        ...base,
        env: {},
      }),
    );
    expect(
      hostKeyFromSpec({
        ...base,
        env: {
          BETA: '2',
          ALPHA: '1',
        },
      }),
    ).toBe(
      hostKeyFromSpec({
        ...base,
        env: {
          ALPHA: '1',
          BETA: '2',
        },
      }),
    );
    expect(hostKeyFromSpec({ ...base, cwd: fixtureCanonicalWorkDir('/workspace/b') })).not.toBe(hostKeyFromSpec(base));
    expect(hostKeyFromSpec({ ...base, env: { CODEX_HOME: '/accounts/a' } })).not.toBe(
      hostKeyFromSpec({ ...base, env: { CODEX_HOME: '/accounts/b' } }),
    );
    const shared = createSharedSpec();
    expect(hostKeyFromSpec({ ...shared, idleRetirement: 'never' })).toBe(hostKeyFromSpec(shared));
    const initialized = createExclusiveSpec({
      initializeRequest: { method: 'initialize', params: { beta: 2, alpha: { y: 2, x: 1 } } },
      initializeTimeoutMs: 1_000,
      shutdownCapability: { method: 'shutdown', timeoutMs: 2_000 },
    });
    expect(hostKeyFromSpec(initialized)).toBe(
      hostKeyFromSpec({
        ...initialized,
        initializeRequest: { method: 'initialize', params: { alpha: { x: 1, y: 2 }, beta: 2 } },
      }),
    );
    expect(hostKeyFromSpec({ ...initialized, initializeTimeoutMs: 1_001 })).not.toBe(hostKeyFromSpec(initialized));
    expect(hostKeyFromSpec({ ...initialized, shutdownCapability: { method: 'stop', timeoutMs: 2_000 } })).not.toBe(
      hostKeyFromSpec(initialized),
    );
  });

  it('deeply snapshots host identity and lifecycle data before caller mutation', async () => {
    let resolveClosed = () => {};
    const server = createFakeProviderServerHandle({
      generation: 10,
      request: async (method) => {
        if (method === 'shutdown-original') resolveClosed();
        return {};
      },
    });
    resolveClosed = server.resolveClosed;
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });
    const spec = createSharedSpec({
      args: ['broker-original'],
      env: { PATH: '/bin/original' },
      initializeRequest: {
        method: 'initialize-original',
        params: { nested: { route: 'original' }, sequence: ['original'] },
      },
      initializeTimeoutMs: 1_000,
      shutdownCapability: { method: 'shutdown-original', timeoutMs: 2_000 },
    });
    const originalIdentity = hostKeyFromSpec(spec);
    const acquisition = manager.openSession(createLaunch(spec));

    spec.args[0] = 'broker-mutated';
    spec.env!.PATH = '/bin/mutated';
    (spec.initializeRequest!.params.nested as { route: string }).route = 'mutated';
    (spec.initializeRequest!.params.sequence as string[])[0] = 'mutated';
    spec.shutdownCapability!.method = 'shutdown-mutated';

    const lease = await acquisition;
    const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
    expect(entry.identityKey).toBe(originalIdentity);
    expect(entry.spec).toMatchObject({
      args: ['broker-original'],
      env: { PATH: '/bin/original' },
      initializeRequest: {
        method: 'initialize-original',
        params: { nested: { route: 'original' }, sequence: ['original'] },
      },
      shutdownCapability: { method: 'shutdown-original', timeoutMs: 2_000 },
    });
    expect(Object.isFrozen(entry.spec)).toBe(true);
    expect(Object.isFrozen(entry.spec.initializeRequest?.params)).toBe(true);
    expect(Object.isFrozen(entry.spec.initializeRequest?.params.nested as object)).toBe(true);
    expect(spawnProviderServer.mock.calls[0]?.[0]).toMatchObject({
      args: ['broker-original'],
      exactEnv: { PATH: '/bin/original' },
      initializeRequest: {
        method: 'initialize-original',
        params: { nested: { route: 'original' }, sequence: ['original'] },
      },
    });
    expect(await manager.attachSession(lease.hostRef, expectedHost(entry.spec))).not.toBeNull();
    expect(
      await manager.attachSession({ ...lease.hostRef, fingerprint: '0'.repeat(64) }, expectedHost(entry.spec)),
    ).toBeNull();
    expect(
      await manager.attachSession({ ...lease.hostRef, ownerJobId: 'forbidden' } as never, expectedHost(entry.spec)),
    ).toBeNull();

    lease.close();
    await manager.shutdown();
    expect(server.requestMock).toHaveBeenCalledWith('shutdown-original', {});
    expect(server.requestMock).not.toHaveBeenCalledWith('shutdown-mutated', {});
  });

  it('never reuses a job-exclusive process and launches only its stable environment', async () => {
    const first = createFakeProviderServerHandle({ generation: 41 });
    const second = createFakeProviderServerHandle({ generation: 42 });
    const spawnProviderServer = createSpawnProviderServerMock(first.handle, second.handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });
    const spec = createExclusiveSpec({ env: { CODEX_HOME: '/accounts/a' } });

    const leaseA = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    const leaseB = await manager.openSession(createLaunch(spec), { jobId: 'job-b' });

    expect(leaseA.hostRef.instanceId).not.toBe(leaseB.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    expect(spawnProviderServer.mock.calls[0]?.[0].exactEnv).toEqual({ CODEX_HOME: '/accounts/a' });
    expect(spawnProviderServer.mock.calls[1]?.[0].exactEnv).toEqual({ CODEX_HOME: '/accounts/a' });

    leaseA.close();
    leaseB.close();
    await manager.shutdown();
  });

  it('single-flights one job-exclusive placement for equal specs with the same owner job', async () => {
    const first = createFakeProviderServerHandle({ generation: 41 });
    const second = createFakeProviderServerHandle({ generation: 41 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(first.handle, second.handle),
    });
    const spec = createExclusiveSpec();

    const sessionA = await manager.openSession(createLaunch(spec), { jobId: 'same-job' });
    const sessionB = await manager.openSession(createLaunch(spec), { jobId: 'same-job' });

    expect(sessionA.hostRef.instanceId).toBe(sessionB.hostRef.instanceId);
    expect((manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.size).toBe(1);
    expect(first.closeMock).not.toHaveBeenCalled();
    expect(await manager.attachSession(sessionA.hostRef, expectedHost(spec, 'same-job'))).not.toBeNull();
    expect(await manager.attachSession(sessionB.hostRef, expectedHost(spec, 'same-job'))).not.toBeNull();

    sessionA.close();
    sessionB.close();
    await manager.shutdown();
  });

  it('classifies an already-closed handle as stale before its cleanup microtask runs', async () => {
    const server = createFakeProviderServerHandle({ generation: 51 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const spec = createSharedSpec();
    const session = await manager.openSession(createLaunch(spec));

    server.resolveClosed();
    await expect(manager.attachSession(session.hostRef, expectedHost(spec))).resolves.toBeNull();
    session.close();
    await manager.shutdown();
  });

  it.each([
    ['shared', 'job-exclusive'],
    ['job-exclusive', 'shared'],
  ] as const)('fails closed when one executable identity changes lease policy from %s to %s', async (first, second) => {
    const handle = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(handle.handle),
    });
    const identity = {
      provider: 'same-provider',
      command: process.execPath,
      args: ['same-app-server.js'],
      cwd: fixtureCanonicalWorkDir(process.cwd()),
    };
    const specFor = (mode: 'shared' | 'job-exclusive') =>
      mode === 'shared' ? createSharedSpec(identity) : createExclusiveSpec(identity);
    const firstSpec = specFor(first);
    const secondSpec = specFor(second);
    const lease = await manager.openSession(
      createLaunch(firstSpec),
      first === 'job-exclusive' ? { jobId: 'job-a' } : {},
    );

    await expect(
      manager.openSession(createLaunch(secondSpec), second === 'job-exclusive' ? { jobId: 'job-b' } : {}),
    ).rejects.toThrow('provider_host_policy_conflict');

    lease.close();
    await manager.shutdown();
  });

  it('remembers an executable identity lease policy after its concrete entry closes', async () => {
    const server = createFakeProviderServerHandle({ generation: 10 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const identity = {
      provider: 'same-provider',
      command: process.execPath,
      args: ['same-app-server.js'],
      cwd: fixtureCanonicalWorkDir(process.cwd()),
    };
    const exclusive = createExclusiveSpec(identity);
    const shared = createSharedSpec(identity);
    const lease = await manager.openSession(createLaunch(exclusive), { jobId: 'job-a' });

    lease.close();
    await server.handle.closePromise;
    await expect(manager.openSession(createLaunch(shared))).rejects.toThrow('provider_host_policy_conflict');
    await manager.shutdown();
  });

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

  it('reuses one shared host and isolates incompatible exclusive hosts', async () => {
    const firstHandle = createFakeProviderServerHandle({ generation: 11 });
    const secondHandle = createFakeProviderServerHandle({ generation: 22 });
    const thirdHandle = createFakeProviderServerHandle({ generation: 33 });
    const spawnProviderServer = createSpawnProviderServerMock(
      firstHandle.handle,
      secondHandle.handle,
      thirdHandle.handle,
    );
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });

    const sharedSpec = createSharedSpec();
    const codexSpecA = createExclusiveSpec({
      cwd: fixtureCanonicalWorkDir('/workspace/a'),
      env: { PROJECT: 'a' },
    });
    const codexSpecB = createExclusiveSpec({
      cwd: fixtureCanonicalWorkDir('/workspace/b'),
      env: { PROJECT: 'b' },
    });

    const sharedLeaseA = await manager.openSession(createLaunch(sharedSpec));
    const sharedLeaseB = await manager.openSession(createLaunch(sharedSpec));
    const codexLeaseA = await manager.openSession(createLaunch(codexSpecA), { jobId: 'job-a' });
    const codexLeaseB = await manager.openSession(createLaunch(codexSpecB), { jobId: 'job-b' });

    expect(sharedLeaseA.hostRef.instanceId).toBe(sharedLeaseB.hostRef.instanceId);
    expect(codexLeaseA.hostRef.instanceId).not.toBe(codexLeaseB.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(3);

    sharedLeaseA.close();
    sharedLeaseB.close();
    codexLeaseA.close();
    codexLeaseB.close();
    await manager.shutdown();
  });

  it('keeps an exclusive host alive until its original and recovered pins are all closed', async () => {
    const server = createFakeProviderServerHandle({ generation: 34 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const spec = createExclusiveSpec();
    const original = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    const recoveredA = await manager.attachSession(original.hostRef, expectedHost(spec, 'job-a'));
    const recoveredB = await manager.attachSession(original.hostRef, expectedHost(spec, 'job-a'));

    expect(recoveredA).not.toBeNull();
    expect(recoveredB).not.toBeNull();
    original.close();
    expect(server.closeMock).not.toHaveBeenCalled();
    recoveredA?.close();
    recoveredA?.close();
    expect(server.closeMock).not.toHaveBeenCalled();
    recoveredB?.close();
    await server.handle.closePromise;

    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('does not idle-evict a shared host while a recovered attachment still pins it', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 35 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
    });
    const spec = createSharedSpec();
    const original = await manager.openSession(createLaunch(spec));
    const recovered = await manager.attachSession(original.hostRef, expectedHost(spec));

    original.close();
    await vi.advanceTimersByTimeAsync(20);
    expect(server.closeMock).not.toHaveBeenCalled();
    server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
    recovered?.close();
    await vi.advanceTimersByTimeAsync(10);

    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('logs every outstanding codex pin when no live job owns the host without closing it', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    const server = createFakeProviderServerHandle({ generation: 35 });
    const liveCodexJobBlocksRetirement = vi.fn(() => false);
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
      carrierBlocksRetirement: liveCodexJobBlocksRetirement,
    });
    const spec = createSharedSpec({
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      idleRetirement: 'unleased',
    });
    const original = await manager.openSession(createLaunch(spec), { jobId: 'job-acquisition' });
    const attached = await manager.attachSession(original.hostRef, expectedHost(spec, 'job-acquisition'));

    await vi.advanceTimersByTimeAsync(1_000);

    const hostLabel = `Provider host codex ${original.hostRef.instanceId} (${spec.cwd})`;
    expect(warning.mock.calls).toEqual([
      [
        `${hostLabel} has an outstanding pin while no live Codex job owns it: origin.kind=acquisition, origin.jobId=job-acquisition`,
      ],
      [
        `${hostLabel} has an outstanding pin while no live Codex job owns it: origin.kind=attached-session, origin.jobId=none (attached session, no job)`,
      ],
    ]);
    expect(liveCodexJobBlocksRetirement).toHaveBeenCalledOnce();
    expect(liveCodexJobBlocksRetirement).toHaveBeenCalledWith(original.hostRef);
    expect(server.closeMock).not.toHaveBeenCalled();

    original.close();
    attached?.close();
    await manager.shutdown();
  });

  it('scopes opaque host references to one concrete manager-owned process instance', async () => {
    const first = createFakeProviderServerHandle({ generation: 36 });
    const second = createFakeProviderServerHandle({ generation: 36 });
    const managerA = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(first.handle),
    });
    const managerB = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(second.handle),
    });
    const launch = createLaunch(createSharedSpec());
    const sessionA = await managerA.openSession(launch);
    const sessionB = await managerB.openSession(launch);

    expect(sessionA.hostRef).toMatchObject({
      fingerprint: sessionB.hostRef.fingerprint,
    });
    expect(sessionA.hostRef.instanceId).not.toBe(sessionB.hostRef.instanceId);
    await expect(managerB.attachSession(sessionA.hostRef, expectedHost(launch))).resolves.toBeNull();
    const recoveredA = await managerA.attachSession(sessionA.hostRef, expectedHost(launch));
    expect(recoveredA).not.toBeNull();

    recoveredA?.close();
    sessionA.close();
    sessionB.close();
    await managerA.shutdown();
    await managerB.shutdown();
  });

  it('closes a released exclusive process and never reuses it', async () => {
    const first = createFakeProviderServerHandle({ generation: 51 });
    const second = createFakeProviderServerHandle({ generation: 52 });
    const spawnProviderServer = createSpawnProviderServerMock(first.handle, second.handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });
    const spec = createExclusiveSpec();

    const firstLease = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    firstLease.close();
    await first.handle.closePromise;
    const secondLease = await manager.openSession(createLaunch(spec), { jobId: 'job-b' });

    expect(first.closeMock).toHaveBeenCalledTimes(1);
    expect(secondLease.hostRef.instanceId).not.toBe(firstLease.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    secondLease.close();
    await manager.shutdown();
  });

  it('lets the shared spawn creator abort while another caller succeeds on the manager-owned spawn', async () => {
    const server = createFakeProviderServerHandle({ generation: 71 });
    const spawn = createDeferred<typeof server.handle>();
    const spawnProviderServer = vi.fn(async (_options: unknown) => spawn.promise);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });
    const launch = createLaunch(createSharedSpec());

    const creatorAbort = new AbortController();
    const creatorAcquisition = manager.openSession(launch, { signal: creatorAbort.signal });
    const otherAcquisition = manager.openSession(launch);
    creatorAbort.abort('creator-only');

    await expect(creatorAcquisition).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_spawn_wait',
      reason: 'creator-only',
    });
    spawn.resolve(server.handle);
    const otherLease = await otherAcquisition;
    const readyLease = await manager.openSession(launch);

    expect(otherLease.hostRef.instanceId).toBe(readyLease.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(1);
    expect(spawnProviderServer.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: false } });
    otherLease.close();
    readyLease.close();
    await manager.shutdown();
  });

  it('requires explicit idle evidence before cleaning up a creator-abandoned shared spawn', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 73 });
    const spawn = createDeferred<typeof server.handle>();
    const spawnProviderServer = vi.fn(async (_options: unknown) => spawn.promise);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
      idleTimeoutMs: 10,
    });
    const creatorAbort = new AbortController();

    const creatorAcquisition = manager.openSession(createLaunch(createSharedSpec()), {
      signal: creatorAbort.signal,
    });
    creatorAbort.abort('creator-only');
    await expect(creatorAcquisition).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_spawn_wait',
      reason: 'creator-only',
    });

    spawn.resolve(server.handle);
    await vi.advanceTimersByTimeAsync(10);

    expect(spawnProviderServer).toHaveBeenCalledTimes(1);
    expect(spawnProviderServer.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: false } });
    expect(server.closeMock).not.toHaveBeenCalled();

    server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('closes an unpinned shared codex host on the idle timer without a host stats report', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 74 });
    const carrierHostInstanceIds = new Set<string>();
    const carrierBlocksRetirement = vi.fn((hostRef: HostRef) => carrierHostInstanceIds.has(hostRef.instanceId));
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
    });
    const lease = await manager.openSession(
      createLaunch(
        createSharedSpec({
          provider: 'codex',
          command: 'codex',
          args: ['app-server'],
          idleRetirement: 'unleased',
        }),
      ),
    );

    lease.close();
    expect(server.closeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(carrierBlocksRetirement).toHaveBeenCalledTimes(2);
    expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(1, lease.hostRef);
    expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(2, lease.hostRef);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('keeps shared hosts with idle retirement disabled alive regardless of pins or host notifications', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 74 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
    });
    const lease = await manager.openSession(createLaunch(createSharedSpec({ idleRetirement: 'never' })));

    lease.close();
    server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
    await vi.advanceTimersByTimeAsync(20);
    expect(server.closeMock).not.toHaveBeenCalled();

    await manager.shutdown();
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('does not let unrelated provider notifications postpone an evidenced idle deadline', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 75 });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
    });
    const lease = await manager.openSession(createLaunch(createSharedSpec()));
    server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
    lease.close();

    await vi.advanceTimersByTimeAsync(5);
    server.emitNotification({ method: 'turn/completed', params: { turnId: 'turn-1' } });
    await vi.advanceTimersByTimeAsync(5);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('rejects an already-aborted caller before returning an already-live shared host', async () => {
    const server = createFakeProviderServerHandle({ generation: 72 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
    });
    const launch = createLaunch(createSharedSpec());
    const liveLease = await manager.openSession(launch);
    const aborted = new AbortController();
    aborted.abort('already-aborted');

    await expect(manager.openSession(launch, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_acquire',
      reason: 'already-aborted',
    });
    expect(spawnProviderServer).toHaveBeenCalledTimes(1);

    liveLease.close();
    await manager.shutdown();
  });

  it('rejects case-fold duplicates inside the stable environment on Windows', async () => {
    const windowsRuntime = {
      time: runtime.time,
      env: { get: runtime.env.get.bind(runtime.env), platform: () => 'win32' },
    } as const;
    const spawnProviderServer = createSpawnProviderServerMock(createFakeProviderServerHandle().handle);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime: windowsRuntime as never,
      spawnProviderServer,
    });

    await expect(
      manager.openSession(
        createLaunch(
          createExclusiveSpec({
            env: { Path: 'C:\\Windows', PATH: 'C:\\Tools' },
          }),
        ),
        { jobId: 'job-host-duplicate' },
      ),
    ).rejects.toThrow("stable host environment contains case-fold duplicate 'Path' and 'PATH'");
    expect(spawnProviderServer).not.toHaveBeenCalled();
  });

  it('rejects new acquisitions during drain and awaits an exclusive release close already in flight', async () => {
    const server = createFakeProviderServerHandle({ generation: 81 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const lease = await manager.openSession(createLaunch(createExclusiveSpec()), { jobId: 'job-a' });

    lease.close();
    let drained = false;
    const drain = manager.drainForHandoff().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(server.closeMock).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    await expect(manager.openSession(createLaunch(createSharedSpec()))).rejects.toThrow('provider_host_draining');

    close.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it('preserves provider_host_draining identity when drain overtakes a pending cold spawn', async () => {
    const server = createFakeProviderServerHandle({ generation: 91 });
    const spawn = createDeferred<typeof server.handle>();
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: vi.fn(async (_options, _sink, _generation, recordContainment) => {
        const handle = await spawn.promise;
        recordContainment?.(handle.containmentIdentity);
        return handle;
      }),
    });

    const acquisition = manager.openSession(createLaunch(createSharedSpec())).catch((error: unknown) => error);
    const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
    if (entry === undefined) throw new Error('pending acquisition did not create a host entry');
    let drained = false;
    const drain = manager.drainForHandoff().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    await expect(manager.openSession(createLaunch(createSharedSpec()))).rejects.toThrow('provider_host_draining');
    spawn.resolve(server.handle);
    await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalled());
    expect(drained).toBe(false);

    close.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    const failure = await acquisition;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('provider_host_draining: Provider server claude drained');
    expect((failure as Error).cause).toBe(entry.closingError);
  });

  it('does not expose a ready shared lease when same-tick drain wins before lease return', async () => {
    const server = createFakeProviderServerHandle({ generation: 92 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const launch = createLaunch(createSharedSpec());
    const initial = await manager.openSession(launch);
    initial.close();

    const racedAcquisition = manager.openSession(launch);
    let drained = false;
    const drain = manager.drainForHandoff().then(() => {
      drained = true;
    });

    await expect(racedAcquisition).rejects.toThrow('drained');
    expect(drained).toBe(false);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    close.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it('keeps an outstanding managed-session pin releasable after drain closes its host', async () => {
    const server = createFakeProviderServerHandle({ generation: 94 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const session = await manager.openSession(createLaunch(createSharedSpec()));

    const drain = manager.drainForHandoff();
    await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalledTimes(1));
    close.resolve();
    await drain;

    expect(() => session.close()).not.toThrow();
    expect(() => session.close()).not.toThrow();
  });

  it('cancels close cleanup after an aborted drain and leaves the unreclaimed group visible', async () => {
    const server = createFakeProviderServerHandle({ generation: 93 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const lease = await manager.openSession(createLaunch(createSharedSpec()));
    lease.close();
    const drainAbort = new AbortController();
    const drain = manager.drainForHandoff(drainAbort.signal);
    drainAbort.abort('caller-stopped-waiting');

    await expect(drain).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_close_wait',
      reason: 'caller-stopped-waiting',
    });
    await vi.waitFor(() =>
      expect(manager.listProviderHosts()).toMatchObject([
        { status: 'reclamation-failed', host: { reclamationAttempts: 1 } },
      ]),
    );
    expect(server.closeMock).not.toHaveBeenCalled();
    close.resolve();
  });

  it('aborts the final wait for an exclusive close removed before drain while shutdown still awaits it once', async () => {
    const server = createFakeProviderServerHandle({ generation: 94 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const lease = await manager.openSession(createLaunch(createExclusiveSpec()), { jobId: 'job-a' });

    lease.close();
    await vi.waitFor(() => expect(server.closeMock).toHaveBeenCalledTimes(1));
    const drainAbort = new AbortController();
    const drain = manager.drainForHandoff(drainAbort.signal);
    drainAbort.abort('stop-exclusive-close-wait');

    await expect(drain).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_close_wait',
      reason: 'stop-exclusive-close-wait',
    });
    let shutDown = false;
    const shutdown = manager.shutdown().then(() => {
      shutDown = true;
    });
    await Promise.resolve();
    expect(shutDown).toBe(false);

    close.resolve();
    await shutdown;
    expect(shutDown).toBe(true);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });
});

describe('provider host pool proxy set registry', () => {
  // Each manager instance is fresh per test, but the module-level `ensureProviderProxySet` mock is shared —
  // its call history must not leak from one `it` into the next.
  beforeEach(() => {
    mockedEnsureProxySet.mockReset();
  });

  it('never attempts proxy set acquisition when constructed without proxySetAcquisition', async () => {
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });

    const lease = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-a' });

    expect(mockedEnsureProxySet).not.toHaveBeenCalled();
    expect(manager.liveSets()).toEqual([]);
    lease.close();
    await manager.shutdown();
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

    const spec = createSharedSpec();
    const first = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    const second = await manager.openSession(createLaunch(spec), { jobId: 'job-b' });

    // Same shared entry both times, so the same hostKey — the second call must not start a second attempt
    // while the first is still pending (`onSettled` was never invoked).
    expect(mockedEnsureProxySet).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
    await manager.shutdown();
  });

  it('exposes an acquired set through liveSets() once the attempt settles, and does not re-acquire once live', async () => {
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    const set = fakeDurableProxySet('proxy-a');
    mockedEnsureProxySet.mockImplementationOnce((_entry, _env, onSettled) => {
      onSettled({ kind: 'acquired', set });
    });

    const lease = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-a' });

    expect(manager.liveSets().map((candidate) => candidate.proxyInstanceId)).toEqual([set.proxyInstanceId]);
    const second = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-b' });
    expect(mockedEnsureProxySet).toHaveBeenCalledTimes(1);

    lease.close();
    second.close();
    await manager.shutdown();
  });

  it('a failed acquisition does not fail openSession and leaves liveSets() empty', async () => {
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    mockedEnsureProxySet.mockImplementationOnce((_entry, _env, onSettled) => {
      onSettled({ kind: 'failed', reason: 'guardian spawn exploded' });
    });

    const lease = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-a' });

    expect(manager.liveSets()).toEqual([]);
    lease.close();
    await manager.shutdown();
  });

  it('routes to the exact live authority for a matching spec once acquisition settles', async () => {
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    const set = fakeDurableProxySet('proxy-routed');
    mockedEnsureProxySet.mockImplementationOnce((_entry, _env, onSettled) => {
      onSettled({ kind: 'acquired', set });
    });
    const spec = createSharedSpec();

    const lease = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });

    expect(manager.routeAppServerOperation(spec)?.proxyInstanceId).toBe(set.proxyInstanceId);

    lease.close();
    await manager.shutdown();
  });

  it('shares one set across job-exclusive entries of the same executable identity', async () => {
    // A set is three real processes and one proxy carries many operations — its ledger is keyed by
    // `(jobId, operationId)`, a handoff grant covers the whole operation set, and release refuses to reap a
    // provider root another operation still references. So the set belongs to the executable identity, not
    // to an acquisition. Keying it per entry would also never terminate: a job-exclusive `hostKey` carries a
    // fresh sequence number every acquisition, and nothing retires a set before coordinator shutdown, so a
    // long-lived daemon would accumulate three processes per job.
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    const set = fakeDurableProxySet('proxy-shared');
    mockedEnsureProxySet.mockImplementationOnce((_entry, _env, onSettled) => {
      onSettled({ kind: 'acquired', set });
    });

    const first = await manager.openSession(createLaunch(createExclusiveSpec()), { jobId: 'job-a' });
    const second = await manager.openSession(createLaunch(createExclusiveSpec()), { jobId: 'job-b' });

    // Two distinct entries — the per-job isolation of the hosts themselves is unchanged — but one set.
    const entryKeys = mockedEnsureProxySet.mock.calls.map((call) => (call[0] as ProviderHostEntry).hostKey);
    expect(new Set(entryKeys).size).toBe(1);
    expect(mockedEnsureProxySet).toHaveBeenCalledTimes(1);
    expect(manager.liveSets()).toHaveLength(1);

    first.close();
    second.close();
    await manager.shutdown();
  });

  it('reserves at most four set slots across pending acquisitions (C3-M7)', async () => {
    const servers = Array.from({ length: 5 }, (_, index) => createFakeProviderServerHandle({ generation: index + 1 }));
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(...servers.map(({ handle }) => handle)),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    mockedEnsureProxySet.mockImplementation(() => {
      // Every reserved slot remains pending while the fifth identity reaches the admission gate.
    });
    const specs = servers.map((_, index) => createSharedSpec({ env: { CORAL_SET_ID: String(index) } }));
    const leases = [];
    for (const [index, spec] of specs.entries()) {
      leases.push(await manager.openSession(createLaunch(spec), { jobId: `job-${index}` }));
    }

    expect(
      mockedEnsureProxySet.mock.calls.length,
      'five live/acquiring/uncontained proxy set slots were admitted',
    ).toBe(4);
    expect(manager.routeAppServerOperation(specs.at(-1) as ProviderServerSpec)).toBeNull();

    for (const lease of leases) lease.close();
    await manager.shutdown();
  });

  it('holds a retiring slot until absence, then rotates to a fresh set before routing new work', async () => {
    const absence = createDeferred<Readonly<{ disappearanceReceipt: string } | { unconfirmed: string }>>();
    const stopAndReap = vi.fn(() => absence.promise);
    const stopHeartbeats = vi.fn();
    const initiateControlClose = vi.fn(async () => {});
    const firstSet = fakeDurableProxySet('proxy-a', {
      prepareOperation: async () => ({
        state: 'capacity',
        retryable: true,
        code: 'provider_root_generation_draining',
        reason: 'generation reached 127 recorded roots',
      }),
      stopAndReap,
      stopHeartbeats,
      initiateControlClose,
    });
    const sets = [
      firstSet,
      fakeDurableProxySet('proxy-b'),
      fakeDurableProxySet('proxy-c'),
      fakeDurableProxySet('proxy-d'),
      fakeDurableProxySet('proxy-a-fresh'),
    ];
    let nextSet = 0;
    mockedEnsureProxySet.mockImplementation((_entry, _env, onSettled) => {
      const set = sets[nextSet++];
      if (set === undefined) throw new Error('unexpected extra proxy set acquisition');
      onSettled({ kind: 'acquired', set });
    });
    const servers = Array.from({ length: 5 }, (_, index) => createFakeProviderServerHandle({ generation: index + 1 }));
    const providerProxyLifecycleRef = createProxySetLifecycleRef((routeKey) =>
      manager.providerProxySlotReleased(routeKey),
    );
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(...servers.map(({ handle }) => handle)),
      proxySetAcquisition,
      providerProxyLifecycleRef,
    });
    const specs = servers.map((_, index) => createSharedSpec({ env: { CORAL_ROTATION_SET: String(index) } }));
    const leases = [];
    for (let index = 0; index < MAX_COORDINATOR_PROXY_SET_SLOTS; index += 1) {
      leases.push(await manager.openSession(specs[index] as ProviderServerSpec, { jobId: `job-${index}` }));
    }
    const routed = manager.routeAppServerOperation(specs[0] as ProviderServerSpec);
    if (routed === null || !('prepareOperation' in routed)) throw new Error('expected a durable routed set');

    await (routed as DurableProviderProxyOperationAuthority).prepareOperation({} as never);
    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(manager.routeAppServerOperation(specs[0] as ProviderServerSpec)).toBeNull();
    leases.push(await manager.openSession(specs[4] as ProviderServerSpec, { jobId: 'job-4' }));
    expect(
      mockedEnsureProxySet.mock.calls.length,
      'a fifth set was acquired before the retiring set proved joint absence',
    ).toBe(MAX_COORDINATOR_PROXY_SET_SLOTS);

    absence.resolve({ disappearanceReceipt: 'joint-absence' });
    await vi.waitFor(() => expect(mockedEnsureProxySet).toHaveBeenCalledTimes(5));
    expect(stopHeartbeats).toHaveBeenCalledOnce();
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(manager.routeAppServerOperation(specs[0] as ProviderServerSpec)?.proxyInstanceId).toBe(
      sets[4]?.proxyInstanceId,
    );
    expect(manager.liveSets()).toHaveLength(MAX_COORDINATOR_PROXY_SET_SLOTS);

    for (const lease of leases) lease.close();
    await manager.shutdown();
  });

  it('aborts a still-pending acquisition’s signal when the manager stops, without waiting for it to settle', async () => {
    // The defect this guards against: a job acquires a lease, its proxy-set acquisition is still mid-
    // handshake when shutdown begins, and nothing ever cuts it off — so it can go on to populate `liveSets()`
    // after a caller (`runShutdownSequence`) has already read it. `stopAndClose` must sever it instead of
    // merely outliving it.
    const server = createFakeProviderServerHandle();
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    let capturedSignal: AbortSignal | undefined;
    mockedEnsureProxySet.mockImplementationOnce((_entry, env: { signal: AbortSignal }) => {
      capturedSignal = env.signal;
      // Deliberately never calls `onSettled` — this attempt is still running when shutdown begins.
    });

    const lease = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-a' });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    lease.close();
    // Must resolve even though the acquisition it started never calls `onSettled` — shutdown does not await
    // acquisition completion, it cuts it off.
    await manager.shutdown();

    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('provider host pool proxy set registration', () => {
  // Exact-set redemption and per-operation attachment live in
  // `coordinator/services/provider-proxy-set/inheritance.ts` and is covered end to end there
  // (`provider-proxy-set-inheritance.test.ts`) — it needs jobs-domain vocabulary this `coordinator/live/`
  // manager may not reach directly. `registerInheritedSet` is the narrow, domain-free seam that mechanism
  // calls back into once it already holds a live, connected set; that hand-off is what this suite exercises.

  // The module-level `ensureProviderProxySet` mock is shared with every other describe block in this file —
  // its call history must not leak from one `it` into the next (mirrors the sibling `beforeEach` above).
  beforeEach(() => {
    mockedEnsureProxySet.mockReset();
  });

  it('folds an inherited set into liveSets() alongside acquired sets, without routing new sessions onto it', async () => {
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(createFakeProviderServerHandle().handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    const set = fakeDurableProxySet('proxy-inherited');

    manager.registerInheritedSet(set);

    expect(manager.liveSets()).toEqual([set]);
    // Inheritance never registers routing for new work — only an `ensureProxySetFor` acquisition does.
    expect(manager.routeAppServerOperation(createSharedSpec())).toBeNull();

    await manager.shutdown();
  });

  it('coexists with an acquired set for a different proxy — liveSets() reports both', async () => {
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(createFakeProviderServerHandle().handle),
      proxySetAcquisition,
      providerProxyLifecycleRef: createProxySetLifecycleRef(),
    });
    const acquired = fakeDurableProxySet('proxy-acquired');
    mockedEnsureProxySet.mockImplementationOnce((_entry, _env, onSettled) => {
      onSettled({ kind: 'acquired', set: acquired });
    });
    const lease = await manager.openSession(createLaunch(createSharedSpec()), { jobId: 'job-a' });
    const inherited = fakeDurableProxySet('proxy-inherited');

    manager.registerInheritedSet(inherited);

    expect(new Set(manager.liveSets().map((set) => set.proxyInstanceId))).toEqual(
      new Set([acquired.proxyInstanceId, inherited.proxyInstanceId]),
    );
    lease.close();
    await manager.shutdown();
  });
});
