import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '#tools/testing/deferred.js';
import { DefaultProviderHostManager, hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import {
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

function expectedHost(spec: ProviderServerSpec, jobId = 'shared-attachment') {
  return { spec, jobId };
}

describe('provider host pool', () => {
  it.each([
    [{ ...createSharedSpec(), idlePolicy: undefined }, 'shared hosts require idlePolicy'],
    [{ ...createSharedSpec(), idlePolicy: 'implicit-timeout' }, 'shared hosts require idlePolicy'],
    [{ ...createExclusiveSpec(), idlePolicy: 'daemon' }, 'job-exclusive hosts cannot declare idlePolicy'],
    [{ ...createExclusiveSpec(), leaseMode: 'unknown' }, "leaseMode must be 'shared' or 'job-exclusive'"],
  ])('rejects malformed runtime lifecycle policy before spawning', async (spec, expected) => {
    const server = createFakeProviderServerHandle();
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });

    await expect(manager.openSession(spec as never, { jobId: 'job-a' })).rejects.toThrow(expected);
    expect(spawnProviderServer).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it('hostKeyFromSpec normalizes env ordering and separates incompatible hosts', () => {
    const base = createExclusiveSpec({ args: ['app-server'], cwd: '/workspace/a' });

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
    expect(hostKeyFromSpec({ ...base, cwd: '/workspace/b' })).not.toBe(hostKeyFromSpec(base));
    expect(hostKeyFromSpec({ ...base, env: { CODEX_HOME: '/accounts/a' } })).not.toBe(
      hostKeyFromSpec({ ...base, env: { CODEX_HOME: '/accounts/b' } }),
    );
    const shared = createSharedSpec();
    expect(hostKeyFromSpec({ ...shared, idlePolicy: 'daemon' })).toBe(hostKeyFromSpec(shared));
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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
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

  it('keeps the exact acquired entry when equal-generation exclusive hosts share an owner job', async () => {
    const first = createFakeProviderServerHandle({ generation: 41 });
    const second = createFakeProviderServerHandle({ generation: 41 });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(first.handle, second.handle),
    });
    const spec = createExclusiveSpec();

    const sessionA = await manager.openSession(createLaunch(spec), { jobId: 'same-job' });
    const sessionB = await manager.openSession(createLaunch(spec), { jobId: 'same-job' });

    expect(sessionA.hostRef.instanceId).not.toBe(sessionB.hostRef.instanceId);
    expect(await manager.attachSession(sessionA.hostRef, expectedHost(spec, 'same-job'))).not.toBeNull();
    expect(await manager.attachSession(sessionB.hostRef, expectedHost(spec, 'same-job'))).not.toBeNull();

    sessionA.close();
    sessionB.close();
    await manager.shutdown();
  });

  it('classifies an already-closed handle as stale before its cleanup microtask runs', async () => {
    const server = createFakeProviderServerHandle({ generation: 51 });
    const manager = new DefaultProviderHostManager({
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
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(handle.handle),
    });
    const identity = {
      provider: 'same-provider',
      command: process.execPath,
      args: ['same-app-server.js'],
      cwd: process.cwd(),
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
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const identity = {
      provider: 'same-provider',
      command: process.execPath,
      args: ['same-app-server.js'],
      cwd: process.cwd(),
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
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const statsSpec = createSharedSpec();
    const lease = await manager.openSession(createLaunch(statsSpec));
    const daemonSpec = createSharedSpec({ idlePolicy: 'daemon' });

    await expect(manager.openSession(createLaunch(daemonSpec))).rejects.toThrow('provider_host_policy_conflict');
    await expect(manager.attachSession(lease.hostRef, expectedHost(daemonSpec))).resolves.toBeNull();

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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });

    const sharedSpec = createSharedSpec();
    const codexSpecA = createExclusiveSpec({
      cwd: '/workspace/a',
      env: { PROJECT: 'a' },
    });
    const codexSpecB = createExclusiveSpec({
      cwd: '/workspace/b',
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
    const manager = new DefaultProviderHostManager({
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
    const manager = new DefaultProviderHostManager({
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

  it('scopes opaque host references to one concrete manager-owned process instance', async () => {
    const first = createFakeProviderServerHandle({ generation: 36 });
    const second = createFakeProviderServerHandle({ generation: 36 });
    const managerA = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(first.handle),
    });
    const managerB = new DefaultProviderHostManager({
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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
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
    expect(spawnProviderServer.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    otherLease.close();
    readyLease.close();
    await manager.shutdown();
  });

  it('requires explicit idle evidence before cleaning up a creator-abandoned shared spawn', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 73 });
    const spawn = createDeferred<typeof server.handle>();
    const spawnProviderServer = vi.fn(async (_options: unknown) => spawn.promise);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer, idleTimeoutMs: 10 });
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
    expect(spawnProviderServer.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(server.closeMock).not.toHaveBeenCalled();

    server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps daemon-lifetime shared hosts alive regardless of pins or host notifications', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 74 });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
    });
    const lease = await manager.openSession(createLaunch(createSharedSpec({ idlePolicy: 'daemon' })));

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
    const manager = new DefaultProviderHostManager({
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
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
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
    const manager = new DefaultProviderHostManager({ runtime: windowsRuntime as never, spawnProviderServer });

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
    const manager = new DefaultProviderHostManager({
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

  it('awaits a pending spawn and its close when drain races initial acquisition', async () => {
    const server = createFakeProviderServerHandle({ generation: 91 });
    const spawn = createDeferred<typeof server.handle>();
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: vi.fn(async () => spawn.promise),
    });

    const acquisition = manager.openSession(createLaunch(createSharedSpec())).catch((error: unknown) => error);
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
    await expect(acquisition).resolves.toMatchObject({ message: expect.stringContaining('drained') });
  });

  it('does not expose a ready shared lease when same-tick drain wins before lease return', async () => {
    const server = createFakeProviderServerHandle({ generation: 92 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new DefaultProviderHostManager({
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
    const manager = new DefaultProviderHostManager({
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

  it('continues close cleanup after an aborted drain wait and lets shutdown await completion', async () => {
    const server = createFakeProviderServerHandle({ generation: 93 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new DefaultProviderHostManager({
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
    let shutDown = false;
    const shutdown = manager.shutdown().then(() => {
      shutDown = true;
    });
    await Promise.resolve();
    expect(shutDown).toBe(false);
    expect(server.closeMock).toHaveBeenCalledTimes(1);

    close.resolve();
    await shutdown;
    expect(shutDown).toBe(true);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the final wait for an exclusive close removed before drain while shutdown still awaits it once', async () => {
    const server = createFakeProviderServerHandle({ generation: 94 });
    const close = createDeferred<void>();
    server.closeMock.mockImplementation(async () => {
      await close.promise;
      server.resolveClosed();
    });
    const manager = new DefaultProviderHostManager({
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
