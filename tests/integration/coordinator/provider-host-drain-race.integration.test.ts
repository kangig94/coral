import { describe, expect, it, vi } from 'vitest';

import { hostKeyFromSpec, type ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import { createDeferred } from '#tools/testing/deferred.js';
import {
  StubbedContainmentProviderHostManager,
  createEntry,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

type ProviderHostManagerInternals = {
  entries: Map<string, ProviderHostEntry>;
  maybeArmIdleTimer(entry: ProviderHostEntry): void;
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

function seedIdleHost(
  manager: StubbedContainmentProviderHostManager,
  spec: ReturnType<typeof createCodexSpec>,
  server: ReturnType<typeof createFakeProviderServerHandle>,
): ProviderHostEntry {
  const hostKey = hostKeyFromSpec(spec);
  const entry = createEntry({
    hostKey,
    identityKey: hostKey,
    spec,
    handle: server.handle,
    containment: server.handle.containmentIdentity,
    instanceId: `instance-${server.handle.generation}`,
  });
  internals(manager).entries.set(hostKey, entry);
  internals(manager).maybeArmIdleTimer(entry);
  return entry;
}

describe('provider host idle close/acquire race', () => {
  it('binds a fresh host when acquisition starts after idle close removes the reaped entry', async () => {
    vi.useFakeTimers();
    const closeWindow = createDeferred();
    const closingServer = createFakeProviderServerHandle({ generation: 811 });
    const freshServer = createFakeProviderServerHandle({ generation: 812 });
    const closingContainment = closingServer.handle.containmentIdentity;
    const reapContainment = vi.fn(async (containment) => {
      if (containment === closingContainment) await closeWindow.promise;
    });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(freshServer.handle),
      idleTimeoutMs: 10,
      reapContainment,
    });
    const spec = createCodexSpec();
    const closingEntry = seedIdleHost(manager, spec, closingServer);

    await vi.advanceTimersByTimeAsync(10);

    expect(reapContainment).toHaveBeenCalledWith(closingContainment);
    expect(closingEntry.closePromise).not.toBeNull();
    const acquired = await manager.openSession(spec);
    const acquiredEntry = internals(manager).entries.get(closingEntry.hostKey);
    expect(acquiredEntry, 'acquirer received the entry whose process group is being reaped').not.toBe(closingEntry);
    expect(acquiredEntry?.containment).toBe(freshServer.handle.containmentIdentity);

    closeWindow.resolve();
    await closingEntry.closePromise;
    acquired.close();
    await manager.shutdown();
  });
});
