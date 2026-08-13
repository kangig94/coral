import { describe, expect, it, vi } from 'vitest';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import { ensureProviderServerHandle } from '#src/coordinator/live/provider-hosts/recovery.js';
import { createHostAdmissionCollection, type HostAdmissionCollection } from '#src/providers/host-admission.js';
import {
  StubbedContainmentProviderHostManager,
  createEntry,
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host recovery', () => {
  it('preserves provider_host_draining identity when an entry is already closing before spawn', async () => {
    const closingError = new Error('Provider server codex drained');
    const entry = createEntry({ closingError });
    const server = createFakeProviderServerHandle();
    const spawnProviderServer = vi.fn(async () => server.handle);

    const failure = await ensureProviderServerHandle(entry, {
      spawnProviderServer,
      closeEntry: vi.fn(async () => {}),
      attachHostNotificationListener: vi.fn(),
      createInstanceId: () => 'unused-instance',
      observeRetired: vi.fn(),
    }).catch((error: unknown) => error);

    expect(spawnProviderServer).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('provider_host_draining: Provider server codex drained');
    expect((failure as Error).cause).toBe(closingError);
  });

  it('records the verified containment identity on the host entry before admitting it', async () => {
    const containmentIdentity = Object.freeze({
      pid: 71,
      processStartedAtSeconds: 1_700_000_071,
      processGroupId: 71,
    });
    const server = createFakeProviderServerHandle({ generation: 71, containmentIdentity });
    const baseAdmission = createHostAdmissionCollection({ classify: () => 'unknown' });
    let containmentAtMarkLive: ProviderHostEntry['containment'] | undefined;
    const admission: HostAdmissionCollection = {
      ...baseAdmission,
      withFreshPlacement: (slot, delegate) =>
        baseAdmission.withFreshPlacement(slot, (reservation) =>
          delegate({
            ...reservation,
            markLive: (ref, generation) => {
              const entry = [
                ...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values(),
              ][0];
              containmentAtMarkLive = entry?.containment;
              reservation.markLive(ref, generation);
            },
          }),
        ),
    };
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      admission,
    });

    const lease = await manager.openSession(createExclusiveSpec(), { jobId: 'job-a' });
    const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];

    expect(containmentAtMarkLive).toEqual(containmentIdentity);
    expect(containmentAtMarkLive?.processGroupId).toBe(containmentAtMarkLive?.pid);
    expect(entry?.containment).toEqual(containmentIdentity);

    lease.close();
    await manager.shutdown();
  });

  it('rejects valid references substituted across profiles or exclusive job owners', async () => {
    const sharedServer = createFakeProviderServerHandle({ generation: 31 });
    const exclusiveServer = createFakeProviderServerHandle({ generation: 32 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(sharedServer.handle, exclusiveServer.handle),
    });
    const profileA = createSharedSpec({ env: { CLAUDE_CONFIG_DIR: '/accounts/a' } });
    const profileB = createSharedSpec({ env: { CLAUDE_CONFIG_DIR: '/accounts/b' } });
    const shared = await manager.openSession(createLaunch(profileA));
    await expect(
      manager.attachSession(shared.hostRef, { spec: profileB, jobId: 'shared-recovery' }),
    ).resolves.toBeNull();

    const exclusiveSpec = createExclusiveSpec({ env: { CODEX_HOME: '/accounts/a' } });
    const exclusive = await manager.openSession(createLaunch(exclusiveSpec), { jobId: 'job-b' });
    await expect(manager.attachSession(exclusive.hostRef, { spec: exclusiveSpec, jobId: 'job-a' })).resolves.toBeNull();

    shared.close();
    exclusive.close();
    await manager.shutdown();
  });

  it('attaches a live exclusive host only when the opaque reference matches', async () => {
    const server = createFakeProviderServerHandle({ generation: 41 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new StubbedContainmentProviderHostManager({ runtime, spawnProviderServer });

    const spec = createExclusiveSpec();
    const lease = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    const expectation = { spec, jobId: 'job-a' };
    const borrowed = await manager.attachSession(lease.hostRef, expectation);
    const mismatched = await manager.attachSession({ ...lease.hostRef, instanceId: 'wrong-instance' }, expectation);

    expect(borrowed).not.toBeNull();
    expect(mismatched).toBeNull();
    await expect(
      borrowed?.session.rpc('ping', { ok: true }) ?? Promise.reject(new Error('missing attachment')),
    ).resolves.toEqual({});

    borrowed?.close();
    lease.close();
    await expect(manager.attachSession(lease.hostRef, expectation)).resolves.toBeNull();
    await manager.shutdown();
  });

  it('passes initializeRequest from spec to spawnProviderServer options', async () => {
    const server = createFakeProviderServerHandle({ generation: 50 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new StubbedContainmentProviderHostManager({ runtime, spawnProviderServer });

    const spec = createExclusiveSpec({
      initializeRequest: {
        method: 'initialize',
        params: { clientInfo: { name: 'coral', version: '0.5.0' } },
      },
      initializeTimeoutMs: 12_345,
    });

    const lease = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    expect(spawnProviderServer).toHaveBeenCalledWith(
      expect.objectContaining({
        initializeRequest: {
          method: 'initialize',
          params: { clientInfo: { name: 'coral', version: '0.5.0' } },
        },
        initializeTimeoutMs: 12_345,
      }),
      expect.any(Function),
      expect.any(Number),
      expect.any(Function),
    );
    lease.close();
    await manager.shutdown();
  });

  it('fails closed for wrong instance, owner, and lease policy', async () => {
    const server = createFakeProviderServerHandle({ generation: 61 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const spec = createExclusiveSpec();
    const lease = await manager.openSession(createLaunch(spec), { jobId: 'job-a' });
    expect(lease.hostRef.leaseMode).toBe('job-exclusive');
    if (lease.hostRef.leaseMode !== 'job-exclusive') throw new Error('expected an exclusive host reference');

    const expectation = { spec, jobId: 'job-a' };
    await expect(manager.attachSession({ ...lease.hostRef, instanceId: '' }, expectation)).resolves.toBeNull();
    await expect(manager.attachSession({ ...lease.hostRef, ownerJobId: 'job-b' }, expectation)).resolves.toBeNull();
    await expect(
      manager.attachSession(
        {
          provider: lease.hostRef.provider,
          fingerprint: lease.hostRef.fingerprint,
          instanceId: 'different-instance',
          leaseMode: 'shared',
        },
        expectation,
      ),
    ).resolves.toBeNull();

    lease.close();
    await manager.shutdown();
  });
});
