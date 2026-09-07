import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ProcessContainmentError, type RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import type {
  HeldProviderServerSpawn,
  ProviderServerFailedSpawnCleanupDisposition,
  SpawnProviderServerFn,
} from '#src/providers/app-server-transport.js';
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
  it('publishes a held failed spawn and lets provider-host eviction take its operator exit', async () => {
    const retry = createDeferred<ProviderServerFailedSpawnCleanupDisposition>();
    const subject = { kind: 'unattributable-process-group' } as const;
    const abandonment = { kind: 'operator-abandoned', subject, processAbsenceProven: false } as const;
    const operatorExit = {
      kind: 'abandon-provider-host-acquisition' as const,
      abandon: vi.fn(() => {
        retry.resolve(abandonment);
        return abandonment;
      }),
    };
    const failure = new ProcessContainmentError(
      'process_identity_unverified',
      'fixture detached process group could not be attributed',
    );
    const held: HeldProviderServerSpawn = {
      kind: 'held-unobservable',
      subject,
      observation: 'unobservable',
      operatorExit,
      retry: () => retry.promise,
      error: failure,
    };
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer: vi.fn<SpawnProviderServerFn>(async () => held),
      reapContainment: vi.fn(),
      allocateProviderServerGeneration: () => 490,
    });
    const opening = manager.openSession(createSharedSpec()).catch((error: unknown) => error);

    await vi.waitFor(() =>
      expect(manager.listProviderHosts()).toMatchObject([
        {
          status: 'reclamation-failed',
          host: {
            reclamationFailure: failure.message,
            reclamationRetryable: true,
          },
        },
      ]),
    );
    const [record] = manager.listProviderHosts();
    if (record === undefined) throw new Error('Expected a held provider-host inventory record.');
    expect(() => providerHostInventorySchema.parse([record])).not.toThrow();
    expect(manager.cleanupObligations().closingHosts[0]).toMatchObject({
      kind: 'provider-server-spawn-cleanup-held',
      operatorExit,
    });

    await expect(manager.evictHost(record.ref)).resolves.toBe(true);
    await expect(opening).resolves.toBe(failure);
    expect(operatorExit.abandon).toHaveBeenCalledOnce();
    expect(manager.listProviderHosts()).toEqual([]);
  });

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

  it('does not let an expired shutdown wait poison an already-running reclamation retry', async () => {
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

    expect(reapContainment).toHaveBeenCalledTimes(3);
    expect(manager.listProviderHosts()).toMatchObject([
      {
        status: 'reclamation-failed',
        host: { reclamationAttempts: 3, reclamationFailure: reapFailure.message },
      },
    ]);
  });

  it('uses a fresh reclamation signal when shutdown retries after its deadline expires', async () => {
    vi.useFakeTimers();
    const reapFailure = new ProcessContainmentError(
      'process_containment_reap_failed',
      'fixture containment remained present through the first shutdown attempt',
    );
    const reapContainment = vi.fn().mockRejectedValueOnce(reapFailure).mockResolvedValue(undefined);
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const { entry, hostRef, manager, server } = await openReclamationTestHost(reapContainment);
    const firstDeadline = new AbortController();

    const firstShutdown = manager.shutdown(firstDeadline.signal);
    await vi.waitFor(() => expect(reapContainment).toHaveBeenCalledOnce());
    const [closingHost] = manager.cleanupObligations().closingHosts;
    expect(closingHost).toMatchObject({
      label: `provider host claude ${hostRef.instanceId}`,
      containment: server.handle.containmentIdentity,
    });
    expect(closingHost?.settlement).toBe(entry.closePromise);

    firstDeadline.abort('first-shutdown-deadline');
    await expect(firstShutdown).rejects.toMatchObject({
      name: 'AbortError',
      reason: 'first-shutdown-deadline',
    });
    await vi.waitFor(() => expect(entry.closePromise).toBeNull());

    const retry = manager.shutdown(new AbortController().signal);
    await expect(retry).resolves.toMatchObject({ kind: 'provider-hosts-quiesced' });
    expect(reapContainment).toHaveBeenCalledTimes(2);
    expect(manager.cleanupObligations().closingHosts).toEqual([]);
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

    await expect(shutdown).resolves.toMatchObject({ name: 'AbortError' });
    expect(spawnSignal).toMatchObject({ aborted: true });
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
