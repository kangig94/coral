import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '#tools/testing/deferred.js';
import { DefaultProviderHostManager, hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import {
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host pool', () => {
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
    const initialized = createExclusiveSpec({
      initializeRequest: { method: 'initialize', params: { beta: 2, alpha: { y: 2, x: 1 } } },
      initializeTimeoutMs: 1_000,
      shutdownCapability: { method: 'shutdown', timeoutMs: 2_000 },
      runtimeMetadata: { transportMode: 'wire-a' },
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
    expect(hostKeyFromSpec({ ...initialized, runtimeMetadata: { transportMode: 'wire-b' } })).not.toBe(
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
      runtimeMetadata: { transportMode: 'wire-original' },
    });
    const originalIdentity = hostKeyFromSpec(spec);
    const acquisition = manager.acquireServer(createLaunch(spec));

    spec.args[0] = 'broker-mutated';
    spec.env!.PATH = '/bin/mutated';
    (spec.initializeRequest!.params.nested as { route: string }).route = 'mutated';
    (spec.initializeRequest!.params.sequence as string[])[0] = 'mutated';
    spec.shutdownCapability!.method = 'shutdown-mutated';
    spec.runtimeMetadata!.transportMode = 'wire-mutated';

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
      runtimeMetadata: { transportMode: 'wire-original' },
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
    expect(await manager.borrowLiveServer(entry.spec, {})).not.toBeNull();
    expect(await manager.borrowLiveServer(spec, {})).toBeNull();

    lease.release();
    await manager.shutdown();
    expect(server.requestMock).toHaveBeenCalledWith('shutdown-original', {});
    expect(server.requestMock).not.toHaveBeenCalledWith('shutdown-mutated', {});
  });

  it('never reuses a job-exclusive process or callback environment across jobs', async () => {
    const first = createFakeProviderServerHandle({ generation: 41 });
    const second = createFakeProviderServerHandle({ generation: 42 });
    const spawnProviderServer = createSpawnProviderServerMock(first.handle, second.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
    const spec = createExclusiveSpec({ env: { CODEX_HOME: '/accounts/a' } });

    const leaseA = await manager.acquireServer(createLaunch(spec, { CORAL_CHILD_PRINCIPAL_HANDLE: 'job-a' }), {
      jobId: 'job-a',
    });
    const leaseB = await manager.acquireServer(createLaunch(spec, { CORAL_CHILD_PRINCIPAL_HANDLE: 'job-b' }), {
      jobId: 'job-b',
    });

    expect(leaseA.generation).toBe(41);
    expect(leaseB.generation).toBe(42);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    expect(spawnProviderServer.mock.calls[0]?.[0].exactEnv).toMatchObject({
      CORAL_CHILD_PRINCIPAL_HANDLE: 'job-a',
    });
    expect(spawnProviderServer.mock.calls[1]?.[0].exactEnv).toMatchObject({
      CORAL_CHILD_PRINCIPAL_HANDLE: 'job-b',
    });

    leaseA.release();
    leaseB.release();
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
    const base = createSharedSpec();
    const firstSpec = { ...base, leaseMode: first };
    const secondSpec = { ...base, leaseMode: second };
    const lease = await manager.acquireServer(
      createLaunch(firstSpec),
      first === 'job-exclusive' ? { jobId: 'job-a' } : {},
    );

    await expect(
      manager.acquireServer(createLaunch(secondSpec), second === 'job-exclusive' ? { jobId: 'job-b' } : {}),
    ).rejects.toThrow('provider_host_policy_conflict');

    lease.release();
    await manager.shutdown();
  });

  it('rejects per-job launch environment on a shared host', async () => {
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(createFakeProviderServerHandle().handle),
    });
    const spec = createSharedSpec({ env: { PATH: '/bin' } });

    await expect(manager.acquireServer(createLaunch(spec, { CORAL_JOB_ID: 'job-a' }))).rejects.toThrow(
      'provider_host_policy_invalid',
    );
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

    const sharedLeaseA = await manager.acquireServer(createLaunch(sharedSpec));
    const sharedLeaseB = await manager.acquireServer(createLaunch(sharedSpec));
    const codexLeaseA = await manager.acquireServer(createLaunch(codexSpecA), { jobId: 'job-a' });
    const codexLeaseB = await manager.acquireServer(createLaunch(codexSpecB), { jobId: 'job-b' });

    expect(sharedLeaseA.generation).toBe(11);
    expect(sharedLeaseB.generation).toBe(11);
    expect(codexLeaseA.generation).toBe(22);
    expect(codexLeaseB.generation).toBe(33);
    expect(spawnProviderServer).toHaveBeenCalledTimes(3);

    sharedLeaseA.release();
    sharedLeaseB.release();
    codexLeaseA.release();
    codexLeaseB.release();
    await manager.shutdown();
  });

  it('rejects turn additions that redefine a stable account binding', async () => {
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(createFakeProviderServerHandle().handle),
    });
    const spec = createExclusiveSpec({ env: { CODEX_HOME: '/accounts/a' } });

    await expect(
      manager.acquireServer(createLaunch(spec, { CODEX_HOME: '/accounts/b' }), { jobId: 'job-a' }),
    ).rejects.toThrow("redefines stable host binding 'CODEX_HOME'");
  });

  it('rejects case-folded stable binding redefinition on Windows', async () => {
    const windowsRuntime = {
      time: runtime.time,
      env: { get: runtime.env.get.bind(runtime.env), platform: () => 'win32' },
    } as const;
    const manager = new DefaultProviderHostManager({
      runtime: windowsRuntime as never,
      spawnProviderServer: createSpawnProviderServerMock(createFakeProviderServerHandle().handle),
    });
    const spec = createExclusiveSpec({ env: { CODEX_HOME: '/accounts/a' } });

    await expect(
      manager.acquireServer(createLaunch(spec, { codex_home: '/accounts/b' }), { jobId: 'job-a' }),
    ).rejects.toThrow("'codex_home' redefines stable host binding 'CODEX_HOME'");
  });

  it('closes a released exclusive process and never reuses it', async () => {
    const first = createFakeProviderServerHandle({ generation: 51 });
    const second = createFakeProviderServerHandle({ generation: 52 });
    const spawnProviderServer = createSpawnProviderServerMock(first.handle, second.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
    const spec = createExclusiveSpec();

    const firstLease = await manager.acquireServer(createLaunch(spec), { jobId: 'job-a' });
    firstLease.release();
    await first.handle.closePromise;
    const secondLease = await manager.acquireServer(createLaunch(spec), { jobId: 'job-b' });

    expect(first.closeMock).toHaveBeenCalledTimes(1);
    expect(secondLease.generation).toBe(52);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    secondLease.release();
    await manager.shutdown();
  });

  it('lets the shared spawn creator abort while another caller succeeds on the manager-owned spawn', async () => {
    const server = createFakeProviderServerHandle({ generation: 71 });
    const spawn = createDeferred<typeof server.handle>();
    const spawnProviderServer = vi.fn(async (_options: unknown) => spawn.promise);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
    const launch = createLaunch(createSharedSpec());

    const creatorAbort = new AbortController();
    const creatorAcquisition = manager.acquireServer(launch, { signal: creatorAbort.signal });
    const otherAcquisition = manager.acquireServer(launch);
    creatorAbort.abort('creator-only');

    await expect(creatorAcquisition).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_spawn_wait',
      reason: 'creator-only',
    });
    spawn.resolve(server.handle);
    const otherLease = await otherAcquisition;
    const readyLease = await manager.acquireServer(launch);

    expect(otherLease.generation).toBe(71);
    expect(readyLease.generation).toBe(71);
    expect(spawnProviderServer).toHaveBeenCalledTimes(1);
    expect(spawnProviderServer.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    otherLease.release();
    readyLease.release();
    await manager.shutdown();
  });

  it('makes a creator-abandoned shared spawn eligible for idle cleanup after manager-owned initialization', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle({ generation: 73 });
    const spawn = createDeferred<typeof server.handle>();
    const spawnProviderServer = vi.fn(async (_options: unknown) => spawn.promise);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer, idleTimeoutMs: 10 });
    const creatorAbort = new AbortController();

    const creatorAcquisition = manager.acquireServer(createLaunch(createSharedSpec()), {
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
    expect(server.closeMock).toHaveBeenCalledTimes(1);
    await manager.shutdown();
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted caller before returning an already-live shared host', async () => {
    const server = createFakeProviderServerHandle({ generation: 72 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });
    const launch = createLaunch(createSharedSpec());
    const liveLease = await manager.acquireServer(launch);
    const aborted = new AbortController();
    aborted.abort('already-aborted');

    await expect(manager.acquireServer(launch, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
      stage: 'provider_host_acquire',
      reason: 'already-aborted',
    });
    expect(spawnProviderServer).toHaveBeenCalledTimes(1);

    liveLease.release();
    await manager.shutdown();
  });

  it('rejects case-fold duplicates inside stable and turn environments on Windows', async () => {
    const windowsRuntime = {
      time: runtime.time,
      env: { get: runtime.env.get.bind(runtime.env), platform: () => 'win32' },
    } as const;
    const spawnProviderServer = createSpawnProviderServerMock(createFakeProviderServerHandle().handle);
    const manager = new DefaultProviderHostManager({ runtime: windowsRuntime as never, spawnProviderServer });

    await expect(
      manager.acquireServer(
        createLaunch(
          createExclusiveSpec({
            env: { Path: 'C:\\Windows', PATH: 'C:\\Tools' },
          }),
        ),
        { jobId: 'job-host-duplicate' },
      ),
    ).rejects.toThrow("stable host environment contains case-fold duplicate 'Path' and 'PATH'");
    await expect(
      manager.acquireServer(createLaunch(createExclusiveSpec(), { Token: 'first', TOKEN: 'second' }), {
        jobId: 'job-turn-duplicate',
      }),
    ).rejects.toThrow("turn environment contains case-fold duplicate 'Token' and 'TOKEN'");
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
    const lease = await manager.acquireServer(createLaunch(createExclusiveSpec()), { jobId: 'job-a' });

    lease.release();
    let drained = false;
    const drain = manager.drainForHandoff().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(server.closeMock).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    await expect(manager.acquireServer(createLaunch(createSharedSpec()))).rejects.toThrow('provider_host_draining');

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

    const acquisition = manager.acquireServer(createLaunch(createSharedSpec())).catch((error: unknown) => error);
    let drained = false;
    const drain = manager.drainForHandoff().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    await expect(manager.acquireServer(createLaunch(createSharedSpec()))).rejects.toThrow('provider_host_draining');
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
    const initial = await manager.acquireServer(launch);
    initial.release();

    const racedAcquisition = manager.acquireServer(launch);
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
    const lease = await manager.acquireServer(createLaunch(createSharedSpec()));
    lease.release();
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
    const lease = await manager.acquireServer(createLaunch(createExclusiveSpec()), { jobId: 'job-a' });

    lease.release();
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
