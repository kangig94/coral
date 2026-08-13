import { describe, expect, it, vi } from 'vitest';

import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import { createDeferred } from '#tools/testing/deferred.js';
import {
  StubbedContainmentProviderHostManager,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

type ProviderHostManagerInternals = {
  entries: Map<string, ProviderHostEntry>;
};

function internals(manager: StubbedContainmentProviderHostManager): ProviderHostManagerInternals {
  return manager as unknown as ProviderHostManagerInternals;
}

function createCodexSpec() {
  return createSharedSpec({
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    idleRetirement: 'unleased',
  });
}

describe('provider host idle close/acquire race', () => {
  it('returns provider_host_draining when production admission races idle reclamation', async () => {
    vi.useFakeTimers();
    const closeWindow = createDeferred();
    const closingServer = createFakeProviderServerHandle({ generation: 811 });
    const freshServer = createFakeProviderServerHandle({ generation: 812 });
    const closingContainment = closingServer.handle.containmentIdentity;
    const reapContainment = vi.fn(async (containment) => {
      if (containment === closingContainment) await closeWindow.promise;
    });
    const spawnProviderServer = createSpawnProviderServerMock(closingServer.handle, freshServer.handle);
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer,
      allocateProviderServerGeneration: (() => {
        let generation = 811;
        return () => generation++;
      })(),
      idleTimeoutMs: 10,
      reapContainment,
    });
    const spec = createCodexSpec();
    const first = await manager.openSession(spec);
    const closingEntry = internals(manager).entries.values().next().value;
    if (closingEntry === undefined) throw new Error('production acquisition did not install a host entry');
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({
      phase: 'live',
      ref: first.hostRef,
      generation: 811,
    });

    first.close();
    await vi.advanceTimersByTimeAsync(10);

    expect(reapContainment).toHaveBeenCalledWith(closingContainment, expect.any(AbortSignal));
    expect(closingEntry.closePromise).not.toBeNull();
    await expect(manager.openSession(spec)).rejects.toThrow(/^provider_host_draining:/u);
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({ ref: first.hostRef });
    expect(spawnProviderServer).toHaveBeenCalledTimes(1);
    expect(reapContainment).toHaveBeenCalledTimes(1);

    closeWindow.resolve();
    await closingEntry.closePromise;
    await Promise.resolve();

    const fresh = await manager.openSession(spec);
    expect(fresh.hostRef).not.toEqual(first.hostRef);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    expect(internals(manager).entries.values().next().value?.containment).toBe(freshServer.handle.containmentIdentity);
    fresh.close();
    await manager.shutdown();
  });
});
