import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ProcessContainmentError, type RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import {
  StubbedContainmentProviderHostManager,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

async function openReclamationTestHost(reapContainment: (identity: RecordedContainmentIdentity) => Promise<void>) {
  const server = createFakeProviderServerHandle({ generation: 491 });
  const manager = new StubbedContainmentProviderHostManager({
    runtime,
    spawnProviderServer: createSpawnProviderServerMock(server.handle),
    reapContainment,
    allocateProviderServerGeneration: () => 491,
  });
  const lease = await manager.openSession(createSharedSpec());
  const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
  if (entry === undefined) throw new Error('provider host entry was not installed');
  return { entry, hostRef: lease.hostRef, manager };
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
    const { hostRef, manager } = await openReclamationTestHost(reapContainment);
    expect(manager.listProviderHosts()).toMatchObject([{ status: 'live', ref: hostRef }]);

    const failedEviction = manager.evictHost(hostRef).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await expect(failedEviction).resolves.toBe(identityFailure);

    expect(reapContainment).toHaveBeenCalledOnce();
    expect(manager.listProviderHosts()).toMatchObject([
      { status: 'reclamation-failed', host: { reclamationAttempts: 1 } },
    ]);
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
    await Promise.resolve();
    expect(reapContainment).toHaveBeenCalledTimes(2);
    expect(entry.containment).toBeNull();
    expect(manager.listProviderHosts()).toEqual([]);
  });
});
