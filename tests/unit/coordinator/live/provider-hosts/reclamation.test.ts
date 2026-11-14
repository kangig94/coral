import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '#tools/testing/deferred.js';

import { backendLog } from '#src/infra/backend-log.js';
import { ProcessContainmentError, type RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import { providerHostInventorySchema } from '#src/providers/host-inventory-schema.js';
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
});

it('retains an accepted turn through failed containment and discharges it after an exact retry proves absence', async () => {
  vi.useFakeTimers();
  vi.spyOn(backendLog, 'error').mockImplementation(() => {});
  const failure = new ProcessContainmentError('process_identity_unverified', 'identity unobservable');
  const reapContainment = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const { hostRef, manager, entry } = await openReclamationTestHost(reapContainment);
  const lease = await manager.attachSession(hostRef, { spec: entry.spec, jobId: 'retained-job' });
  if (lease === null) throw new Error('fixture attachment missing');
  const close = vi.fn(() => lease.close());
  const settlement = { providerTurnId: 'retained-turn', settle: async () => null, close };
  expect(manager.acceptTurnContainment({ settlement, lease })).toEqual({
    kind: 'accepted',
    owner: 'provider-host-manager',
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(close).not.toHaveBeenCalled();
  expect(manager.inspectProviderHost(hostRef)).toMatchObject({
    status: 'reclamation-failed',
    host: {
      reclamationFailure: expect.stringContaining('retained-turn'),
    },
  });
  await expect(manager.evictHost(hostRef)).resolves.toEqual({ kind: 'evicted' });
  expect(reapContainment).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it('accepts a retained sibling turn after its exact host has already been contained', async () => {
  vi.useFakeTimers();
  const { hostRef, manager, entry } = await openReclamationTestHost(async () => {});
  const lease = await manager.attachSession(hostRef, { spec: entry.spec, jobId: 'late-turn' });
  if (lease === null) throw new Error('fixture attachment missing');
  await manager.evictHost(hostRef);
  const close = vi.fn(() => lease.close());
  const settlement = { providerTurnId: 'late-turn', settle: async () => null, close };
  expect(manager.acceptTurnContainment({ settlement, lease })).toEqual({
    kind: 'accepted',
    owner: 'provider-host-manager',
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledOnce();
});

it('accepts a sibling turn while exact host containment is already pending', async () => {
  vi.useFakeTimers();
  const absent = createDeferred();
  const { hostRef, manager, entry } = await openReclamationTestHost(() => absent.promise);
  const lease = await manager.attachSession(hostRef, { spec: entry.spec, jobId: 'sibling-turn' });
  if (lease === null) throw new Error('fixture attachment missing');
  const closing = manager.evictHost(hostRef);
  const close = vi.fn(() => lease.close());
  manager.acceptTurnContainment({
    settlement: { providerTurnId: 'sibling-turn', settle: async () => null, close },
    lease,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(close).not.toHaveBeenCalled();
  absent.resolve();
  await closing;
  expect(close).toHaveBeenCalledOnce();
});
