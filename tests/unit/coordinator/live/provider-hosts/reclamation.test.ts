import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ProcessContainmentError, type RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import type { SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import { providerHostInventorySchema } from '#src/providers/host-inventory-schema.js';
import { createDeferred } from '#tools/testing/deferred.js';
import {
  StubbedContainmentProviderHostManager,
  noCarrierBlocksRetirement,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

async function openReclamationTestHost(reapContainment: (identity: RecordedContainmentIdentity) => Promise<void>) {
  const server = createFakeProviderServerHandle({ generation: 491 });
  const manager = new StubbedContainmentProviderHostManager({
    carrierBlocksRetirement: noCarrierBlocksRetirement,
    runtime,
    spawnProviderServer: createSpawnProviderServerMock(server.handle),
    reapContainment,
    allocateProviderServerGeneration: () => 491,
  });
  const lease = await manager.openSession(createSharedSpec());
  const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
  if (entry === undefined) throw new Error('provider host entry was not installed');
  return { entry, hostRef: lease.hostRef, manager, server };
}

describe('provider host reclamation', () => {
  it('does not retry reclamation when process identity cannot be verified', async () => {
    vi.useFakeTimers();
    const identityFailure = new ProcessContainmentError(
      'process_identity_unverified',
      'fixture process identity mismatch',
    );
    const reapContainment = vi.fn().mockRejectedValue(identityFailure);
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const { hostRef, manager, server } = await openReclamationTestHost(reapContainment);
    expect(manager.listProviderHosts()).toMatchObject([{ status: 'live', ref: hostRef }]);

    const failedEviction = manager.evictHost(hostRef).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await expect(failedEviction).resolves.toBe(identityFailure);

    expect(reapContainment).toHaveBeenCalledOnce();
    expect(manager.listProviderHosts()).toMatchObject([
      {
        status: 'reclamation-failed',
        host: {
          pid: server.handle.containmentIdentity.pid,
          processGroupId: server.handle.containmentIdentity.processGroupId,
          reclamationAttempts: 1,
        },
      },
    ]);
    expect(() => providerHostInventorySchema.parse(manager.listProviderHosts())).not.toThrow();
  });

  it('clears failed reclamation state when a retry succeeds', async () => {
    vi.useFakeTimers();
    const reapFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture containment reap failed once',
    );
    const reapContainment = vi.fn().mockRejectedValueOnce(reapFailure).mockResolvedValue(undefined);
    const { entry, hostRef, manager } = await openReclamationTestHost(reapContainment);
    expect(manager.listProviderHosts()).toMatchObject([{ status: 'live', ref: hostRef }]);

    const eviction = manager.evictHost(hostRef);
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.listProviderHosts()).toMatchObject([
      { status: 'reclamation-failed', host: { reclamationAttempts: 1 } },
    ]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(eviction).resolves.toBe(true);
    await vi.waitFor(() => expect(manager.listProviderHosts()).toEqual([]));
    expect(reapContainment).toHaveBeenCalledTimes(2);
    expect(entry.containment).toBeNull();
  });

  it('stops an already-running reclamation retry when lifecycle cancellation aborts the retry delay', async () => {
    vi.useFakeTimers();
    const reapFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture containment remained present',
    );
    const reapContainment = vi.fn().mockRejectedValue(reapFailure);
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const { manager, server } = await openReclamationTestHost(reapContainment);
    const lifecycle = new AbortController();

    server.resolveClosed();
    await server.handle.closePromise;
    await vi.waitFor(() => expect(reapContainment).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(manager.listProviderHosts()).toMatchObject([
        {
          status: 'reclamation-failed',
          host: { reclamationAttempts: 1, reclamationFailure: reapFailure.message },
        },
      ]),
    );

    const shutdown = manager.shutdown(lifecycle.signal).catch((error: unknown) => error);
    lifecycle.abort('lifecycle-deadline');
    await expect(shutdown).resolves.toMatchObject({
      name: 'AbortError',
      reason: 'lifecycle-deadline',
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reapContainment).toHaveBeenCalledOnce();
    expect(manager.listProviderHosts()).toMatchObject([
      {
        status: 'reclamation-failed',
        host: { reclamationAttempts: 1, reclamationFailure: reapFailure.message },
      },
    ]);
  });

  it('leaves an unresolved spawn wait visible as reclamation-failed when lifecycle cancellation aborts it', async () => {
    const spawned = createDeferred<ReturnType<typeof createFakeProviderServerHandle>['handle']>();
    let spawnSignal: AbortSignal | undefined;
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (options) => {
      spawnSignal = options.signal;
      options.signal?.addEventListener('abort', () => spawned.reject(options.signal?.reason), { once: true });
      return spawned.promise;
    });
    const reapContainment = vi.fn();
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
      reapContainment,
      allocateProviderServerGeneration: () => 492,
    });
    const opening = manager.openSession(createSharedSpec()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(spawnProviderServer).toHaveBeenCalledOnce());
    expect(spawnSignal?.aborted).toBe(false);
    const lifecycle = new AbortController();

    const shutdown = manager.shutdown(lifecycle.signal).catch((error: unknown) => error);
    lifecycle.abort('lifecycle-deadline');

    await expect(shutdown).resolves.toMatchObject({ name: 'AbortError', reason: 'lifecycle-deadline' });
    expect(spawnSignal).toMatchObject({ aborted: true, reason: 'lifecycle-deadline' });
    expect(manager.listProviderHosts()).toMatchObject([
      {
        status: 'reclamation-failed',
        host: { reclamationAttempts: 1, reclamationRetryable: false },
      },
    ]);
    expect(manager.listProviderHosts()[0]?.host).not.toHaveProperty('pid');
    expect(manager.listProviderHosts()[0]?.host).not.toHaveProperty('processGroupId');
    expect(() => providerHostInventorySchema.parse(manager.listProviderHosts())).not.toThrow();
    expect(reapContainment).not.toHaveBeenCalled();

    await expect(opening).resolves.toBeInstanceOf(Error);
    expect(reapContainment).not.toHaveBeenCalled();
  });

  it('does not let one host failure detach another host reclamation from lifecycle cancellation', async () => {
    vi.useFakeTimers();
    const first = createFakeProviderServerHandle({ generation: 493 });
    const second = createFakeProviderServerHandle({ generation: 494 });
    const identityFailure = new ProcessContainmentError(
      'process_identity_unverified',
      'fixture first host identity mismatch',
    );
    const retryableFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture second host remained present',
    );
    const reapContainment = vi.fn(async (containment: RecordedContainmentIdentity) => {
      throw containment === first.handle.containmentIdentity ? identityFailure : retryableFailure;
    });
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(first.handle, second.handle),
      reapContainment,
      allocateProviderServerGeneration: (() => {
        let generation = 493;
        return () => generation++;
      })(),
    });
    await manager.openSession(createSharedSpec({ provider: 'claude' }));
    await manager.openSession(createSharedSpec({ provider: 'codex' }));
    const lifecycle = new AbortController();
    let settled = false;

    const shutdown = manager.shutdown(lifecycle.signal).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(reapContainment).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(manager.listProviderHosts().filter(({ status }) => status === 'reclamation-failed')).toHaveLength(2),
    );
    expect(settled).toBe(false);

    lifecycle.abort('lifecycle-deadline');
    await expect(shutdown).resolves.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reapContainment).toHaveBeenCalledTimes(2);
  });
});
