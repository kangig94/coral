import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '#tools/testing/deferred.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import type { HostRef } from '#src/providers/contract.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import {
  ProviderHostAdministrationService,
  type ProviderHostAdministrationOwner,
  type ProviderHostInventoryRecord,
} from '#src/coordinator/services/provider-host-administration.js';
import {
  StubbedContainmentProviderHostManager,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const fingerprint = 'a'.repeat(64);
const workDir = canonicalWorkDirWireSchema.parse('/workspace');

function hostRef(instanceId: string): HostRef {
  return {
    provider: 'codex',
    fingerprint,
    instanceId,
    leaseMode: 'shared',
  };
}

function record(ref: HostRef, status: 'live' | 'retired-blocked' = 'live'): ProviderHostInventoryRecord {
  return {
    ref,
    status,
    spec: {
      provider: ref.provider,
      command: 'codex',
      args: ['app-server'],
      cwd: workDir,
      leaseMode: ref.leaseMode,
      idleRetirement: ref.leaseMode === 'shared' ? 'never' : null,
    },
    host: { owner: status === 'live' ? 'coordinator' : 'provider-proxy' },
    diagnostics: {
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 0,
    },
    diagnosticsRetention: { ownerBudgetTruncated: false },
  };
}

function owner(
  ownerId: string,
  records: readonly ProviderHostInventoryRecord[],
  overrides: Partial<ProviderHostAdministrationOwner> = {},
): ProviderHostAdministrationOwner & {
  listProviderHosts: ReturnType<typeof vi.fn>;
  inspectProviderHost: ReturnType<typeof vi.fn>;
  evictProviderHost: ReturnType<typeof vi.fn>;
} {
  return {
    ownerId,
    listProviderHosts: vi.fn(async () => records),
    inspectProviderHost: vi.fn(async (ref: HostRef) => records.find((entry) => entry.ref === ref) ?? null),
    evictProviderHost: vi.fn(async () => true),
    ...overrides,
  } as never;
}

describe('provider host administration', () => {
  it('keeps exhausted reclamation visible and operable through provider host administration', async () => {
    vi.useFakeTimers();
    const reapFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture containment reap failed',
    );
    const firstReap = createDeferred<void>();
    const reapContainment = vi
      .fn()
      .mockImplementationOnce(async () => firstReap.promise)
      .mockRejectedValue(reapFailure);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const server = createFakeProviderServerHandle({ generation: 501 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      reapContainment,
      allocateProviderServerGeneration: () => 501,
    });
    const lease = await manager.openSession(createSharedSpec());
    const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
    if (entry === undefined) throw new Error('provider host entry was not installed');
    const local: ProviderHostAdministrationOwner = {
      ownerId: 'coordinator:test',
      listProviderHosts: () => manager.listProviderHosts(),
      inspectProviderHost: (ref) => manager.inspectProviderHost(ref),
      evictProviderHost: (ref) => manager.evictHost(ref),
    };
    const service = new ProviderHostAdministrationService({ owners: () => [local] });
    await expect(service.list()).resolves.toMatchObject([{ status: 'live', ref: lease.hostRef }]);

    server.resolveClosed();
    await server.handle.closePromise;
    await Promise.resolve();
    const failedOperation = entry.closePromise;
    if (failedOperation === null) throw new Error('process death did not start reclamation');
    const observedFailure = failedOperation.catch((error: unknown) => error);
    firstReap.reject(reapFailure);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(observedFailure).resolves.toBe(reapFailure);
    await Promise.resolve();

    expect(reapContainment).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('attempts=3'), reapFailure);

    const failedRow = {
      ownerId: 'coordinator:test',
      ref: lease.hostRef,
      status: 'reclamation-failed',
      host: {
        owner: 'coordinator',
        pid: server.handle.containmentIdentity.pid,
        processGroupId: server.handle.containmentIdentity.processGroupId,
        reclamationAttempts: 3,
        reclamationFailure: reapFailure.message,
      },
    };
    await expect(service.list()).resolves.toMatchObject([failedRow]);
    await expect(service.inspect({ hostRef: lease.hostRef })).resolves.toMatchObject(failedRow);

    reapContainment.mockResolvedValue(undefined);
    await expect(service.evict({ hostRef: lease.hostRef })).resolves.toEqual({
      ownerId: 'coordinator:test',
      hostRef: lease.hostRef,
    });
    await expect(service.list()).resolves.toEqual([]);
    expect(entry.containment).toBeNull();
    expect(reapContainment).toHaveBeenCalledTimes(4);
    lease.close();
  });

  it('joins an in-flight reclamation retry when eviction arrives through provider-host administration', async () => {
    vi.useFakeTimers();
    const reapFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture first reclamation failed',
    );
    const retryReap = createDeferred<void>();
    const reapContainment = vi
      .fn()
      .mockRejectedValueOnce(reapFailure)
      .mockImplementationOnce(async () => retryReap.promise);
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const server = createFakeProviderServerHandle({ generation: 502 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      reapContainment,
      allocateProviderServerGeneration: () => 502,
    });
    const lease = await manager.openSession(createSharedSpec());
    const evictionStarted = createDeferred<void>();
    const local: ProviderHostAdministrationOwner = {
      ownerId: 'coordinator:test',
      listProviderHosts: () => manager.listProviderHosts(),
      inspectProviderHost: (ref) => manager.inspectProviderHost(ref),
      evictProviderHost: (ref) => {
        evictionStarted.resolve();
        return manager.evictHost(ref);
      },
    };
    const service = new ProviderHostAdministrationService({ owners: () => [local] });

    server.resolveClosed();
    await server.handle.closePromise;
    for (let round = 0; round < 8; round += 1) await Promise.resolve();
    await expect(service.list()).resolves.toMatchObject([
      { status: 'reclamation-failed', host: { reclamationAttempts: 1 } },
    ]);
    const eviction = service.evict({ hostRef: lease.hostRef });
    await evictionStarted.promise;
    let settled = false;
    void eviction.finally(() => {
      settled = true;
    });

    expect(reapContainment).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(reapContainment).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reapContainment).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    retryReap.resolve();
    await expect(eviction).resolves.toEqual({ ownerId: 'coordinator:test', hostRef: lease.hostRef });
    await expect(service.list()).resolves.toEqual([]);
    expect(reapContainment).toHaveBeenCalledTimes(2);
    lease.close();
  });

  it('returns one complete local-and-proxy snapshot including retained blocked tombstones', async () => {
    const local = owner('coordinator', [record(hostRef('live'))]);
    const proxy = owner('proxy-a', [record(hostRef('retired'), 'retired-blocked')]);
    const service = new ProviderHostAdministrationService({ owners: () => [local, proxy] });

    await expect(service.list()).resolves.toMatchObject([
      { ownerId: 'coordinator', status: 'live', ref: { instanceId: 'live' } },
      { ownerId: 'proxy-a', status: 'retired-blocked', ref: { instanceId: 'retired' } },
    ]);
    expect(local.listProviderHosts).toHaveBeenCalledOnce();
    expect(proxy.listProviderHosts).toHaveBeenCalledOnce();
  });

  it('revalidates one exact ref at its captured owner before inspect and eviction', async () => {
    const selectedRef = hostRef('selected');
    const selectedRecord = record(selectedRef);
    const selected = owner('coordinator', [selectedRecord], {
      inspectProviderHost: vi.fn(async () => selectedRecord),
      evictProviderHost: vi.fn(async () => true),
    });
    const untouched = owner('proxy-a', [record(hostRef('untouched'))]);
    const service = new ProviderHostAdministrationService({ owners: () => [selected, untouched] });

    await expect(service.inspect({ hostRef: selectedRef })).resolves.toMatchObject({
      ownerId: 'coordinator',
      ref: selectedRef,
    });
    await expect(service.evict({ hostRef: selectedRef })).resolves.toEqual({
      ownerId: 'coordinator',
      hostRef: selectedRef,
    });
    expect(selected.inspectProviderHost).toHaveBeenCalledExactlyOnceWith(selectedRef);
    expect(selected.evictProviderHost).toHaveBeenCalledExactlyOnceWith(selectedRef);
    expect(untouched.inspectProviderHost).not.toHaveBeenCalled();
    expect(untouched.evictProviderHost).not.toHaveBeenCalled();
  });

  it('accepts an exact live-to-tombstone transition during selected-owner revalidation', async () => {
    const selectedRef = hostRef('selected');
    const selected = owner('coordinator', [record(selectedRef)], {
      inspectProviderHost: vi.fn(async () => record(selectedRef, 'retired-blocked')),
    });
    const service = new ProviderHostAdministrationService({ owners: () => [selected] });

    await expect(service.inspect({ hostRef: selectedRef })).resolves.toMatchObject({
      ownerId: 'coordinator',
      ref: selectedRef,
      status: 'retired-blocked',
    });
  });

  it('refuses an ambiguous work directory and performs no destructive call', async () => {
    const first = owner('coordinator', [record(hostRef('first'))]);
    const second = owner('proxy-a', [record(hostRef('second'))]);
    const service = new ProviderHostAdministrationService({ owners: () => [first, second] });

    await expect(service.evict({ workDir })).rejects.toMatchObject({
      code: 'provider_host_ambiguous',
      matches: [{ instanceId: 'first' }, { instanceId: 'second' }],
    });
    expect(first.evictProviderHost).not.toHaveBeenCalled();
    expect(second.evictProviderHost).not.toHaveBeenCalled();
  });

  it.each(['list', 'inspect', 'evict'] as const)(
    'fails %s closed when any captured owner inventory is unavailable',
    async (operation) => {
      const selectedRef = hostRef('selected');
      const selected = owner('coordinator', [record(selectedRef)]);
      const unavailable = owner('proxy-a', [], {
        listProviderHosts: vi.fn(async () => Promise.reject(new Error('control lost'))),
      });
      const service = new ProviderHostAdministrationService({ owners: () => [selected, unavailable] });

      const result =
        operation === 'list'
          ? service.list()
          : operation === 'inspect'
            ? service.inspect({ hostRef: selectedRef })
            : service.evict({ hostRef: selectedRef });
      await expect(result).rejects.toMatchObject({
        code: 'provider_host_inventory_unavailable',
        ownerIds: ['proxy-a'],
      });
      expect(selected.inspectProviderHost).not.toHaveBeenCalled();
      expect(selected.evictProviderHost).not.toHaveBeenCalled();
    },
  );

  it('treats a malformed successful owner inventory as unavailable instead of returning partial rows', async () => {
    const local = owner('coordinator', [record(hostRef('selected'))]);
    const malformed = owner('proxy-a', [], {
      listProviderHosts: vi.fn(async () => [{ ...record(hostRef('bad')), extra: true }] as never),
    });
    const service = new ProviderHostAdministrationService({ owners: () => [local, malformed] });

    await expect(service.list()).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['proxy-a'],
    });
  });

  it('never reroutes by cwd when the selected exact ref retires or its owner disappears', async () => {
    const selectedRef = hostRef('selected');
    const replacementRef = hostRef('replacement');
    const selected = owner('proxy-a', [record(selectedRef)], {
      inspectProviderHost: vi.fn(async () => null),
      evictProviderHost: vi.fn(async () => false),
    });
    const replacement = owner('proxy-b', [record(replacementRef)]);
    const service = new ProviderHostAdministrationService({ owners: () => [selected, replacement] });

    await expect(service.inspect({ hostRef: selectedRef })).rejects.toMatchObject({ code: 'provider_host_stale' });
    await expect(service.evict({ hostRef: selectedRef })).rejects.toMatchObject({ code: 'provider_host_stale' });
    expect(replacement.inspectProviderHost).not.toHaveBeenCalled();
    expect(replacement.evictProviderHost).not.toHaveBeenCalled();

    selected.inspectProviderHost.mockRejectedValueOnce(new Error('owner disappeared'));
    await expect(service.inspect({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['proxy-a'],
    });
    expect(replacement.inspectProviderHost).not.toHaveBeenCalled();
  });

  it('distinguishes complete-snapshot absence from duplicate exact identity', async () => {
    const selectedRef = hostRef('selected');
    const empty = owner('coordinator', []);
    await expect(
      new ProviderHostAdministrationService({ owners: () => [empty] }).inspect({ hostRef: selectedRef }),
    ).rejects.toMatchObject({ code: 'provider_host_not_found' });

    const first = owner('coordinator', [record(selectedRef)]);
    const duplicate = owner('proxy-a', [record(selectedRef)]);
    const service = new ProviderHostAdministrationService({ owners: () => [first, duplicate] });
    await expect(service.evict({ hostRef: selectedRef })).rejects.toMatchObject({
      code: 'provider_host_identity_integrity',
      matches: [selectedRef, selectedRef],
    });
    expect(first.evictProviderHost).not.toHaveBeenCalled();
    expect(duplicate.evictProviderHost).not.toHaveBeenCalled();
  });

  it('captures the owner set once so owners appearing mid-operation wait for the next operation', async () => {
    const selectedRef = hostRef('selected');
    let owners: readonly ProviderHostAdministrationOwner[];
    const added = owner('proxy-added', [record(hostRef('added'))]);
    const local = owner('coordinator', [record(selectedRef)], {
      listProviderHosts: vi.fn(async () => {
        owners = [local, added];
        return [record(selectedRef)];
      }),
    });
    owners = [local];
    const ownerSource = vi.fn(() => owners);
    const service = new ProviderHostAdministrationService({ owners: ownerSource });

    await expect(service.list()).resolves.toHaveLength(1);
    expect(ownerSource).toHaveBeenCalledOnce();
    expect(added.listProviderHosts).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toHaveLength(2);
  });
});
