import { describe, expect, it, vi } from 'vitest';

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
