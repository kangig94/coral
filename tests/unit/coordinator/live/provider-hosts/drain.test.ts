import { describe, expect, it, vi } from 'vitest';
import { activePinCount, acquireProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import type { ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import {
  closeProviderServerEntry,
  createProviderHostContainmentReaper,
  shutdownHandle,
} from '#src/coordinator/live/provider-hosts/drain.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import { backendLog } from '#src/infra/backend-log.js';
import { createDeferred } from '#tools/testing/deferred.js';
import {
  StubbedContainmentProviderHostManager,
  createEntry,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  randomSequence,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const containment: RecordedContainmentIdentity = Object.freeze({
  pid: 481,
  processStartedAtSeconds: 1_700_000_481,
  processGroupId: 481,
});

function createRecordingReaper(processStartedAtSeconds = containment.processStartedAtSeconds) {
  let elapsedMs = 0;
  let groupAlive = true;
  const signals: Array<readonly [number, NodeJS.Signals | 0]> = [];
  const clock = createMonotonicClock(Symbol('provider-host-reaper-test'), {
    readMilliseconds: () => BigInt(elapsedMs),
    sleep: async (milliseconds) => {
      elapsedMs += milliseconds;
    },
  });
  const reaper = createProviderHostContainmentReaper(
    {
      env: { ...runtime.env, platform: () => 'linux' },
      process: {
        ...runtime.process,
        isAlive: (pid) => pid === containment.pid || (pid === -containment.processGroupId && groupAlive),
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 'SIGKILL') groupAlive = false;
          return true;
        },
      },
    },
    {
      clock,
      readProcessStartedAtSeconds: (pid) => (pid === containment.pid ? processStartedAtSeconds : null),
    },
  );
  return { reaper, signals };
}

async function closeRecordedEntry(
  reaper: ReturnType<typeof createRecordingReaper>['reaper'],
): Promise<ReturnType<typeof createFakeProviderServerHandle>> {
  const server = createFakeProviderServerHandle({ containmentIdentity: containment });
  const finishCloseAfterReap = vi.fn(async () => {
    server.resolveClosed();
  });
  server.handle.finishCloseAfterReap = finishCloseAfterReap;
  const entry = createEntry({
    handle: server.handle,
    containment,
    instanceId: 'provider-host-instance',
  });

  await closeProviderServerEntry(entry, 'drained', {
    runtime,
    entries: new Map([[entry.hostKey, entry]]),
    shutdownHandle: (handle, spec, identity) => shutdownHandle(handle, spec, identity, runtime.time, reaper),
    reapContainment: reaper,
  });

  expect(finishCloseAfterReap).toHaveBeenCalledOnce();
  return server;
}

describe('provider host drain properties', () => {
  it('drives the default containment clock from the runtime monotonic source', async () => {
    const wallNow = vi.fn(() => {
      throw new Error('wall time must not drive containment deadlines');
    });
    let elapsedMilliseconds = 1_000n;
    const monotonicNow = vi.fn(() => elapsedMilliseconds);
    const reaper = createProviderHostContainmentReaper({
      ...runtime,
      time: {
        ...runtime.time,
        now: wallNow,
        monotonicNow,
        sleep: async (milliseconds) => {
          elapsedMilliseconds += BigInt(milliseconds);
        },
      },
      env: { ...runtime.env, platform: () => 'linux' },
      process: {
        ...runtime.process,
        kill: () => false,
        isAlive: () => false,
        readProcessStartedAtSeconds: () => null,
      },
    });

    await reaper(containment);

    expect(monotonicNow).toHaveBeenCalled();
    expect(wallNow).not.toHaveBeenCalled();
  });

  it('balances acquired and released leases at drain completion across 100 random sequences', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const entry = createEntry();
      const entries = new Map([[entry.hostKey, entry]]);
      const releasePins: Array<() => void> = [];
      let acquiredLeaseCount = 0;
      let releasedLeaseCount = 0;

      for (const step of randomSequence(seed)) {
        if (step % 2 === 0 || activePinCount(entry) === 0) {
          releasePins.push(acquireProviderHostPin(entry, { kind: 'acquisition' }, () => {}));
          acquiredLeaseCount += 1;
        } else {
          releasePins.pop()?.();
          releasedLeaseCount += 1;
        }
      }

      const outstandingBeforeDrain = activePinCount(entry);
      await closeProviderServerEntry(entry, 'drained', {
        runtime,
        entries,
        shutdownHandle: async () => {},
        reapContainment: async () => {},
      });

      expect(activePinCount(entry)).toBe(outstandingBeforeDrain);
      expect(acquiredLeaseCount).toBe(releasedLeaseCount + outstandingBeforeDrain);
      for (const releasePin of releasePins) releasePin();
      expect(activePinCount(entry)).toBe(0);
    }
  });

  it('signals the recorded negative process group with TERM then KILL for coordinator-local host close', async () => {
    const recording = createRecordingReaper();

    const server = await closeRecordedEntry(recording.reaper);

    expect(recording.signals).toEqual([
      [-containment.processGroupId, 'SIGTERM'],
      [-containment.processGroupId, 'SIGKILL'],
    ]);
    expect(server.closeMock, 'child-only gracefulKill teardown was used').not.toHaveBeenCalled();
  });

  it('does not signal a recycled coordinator-local process group', async () => {
    const recording = createRecordingReaper(containment.processStartedAtSeconds + 1);

    const server = await closeRecordedEntry(recording.reaper);

    expect(recording.signals).toEqual([]);
    expect(server.closeMock).not.toHaveBeenCalled();
  });

  it.each(['idle retirement', 'eviction', 'drainForHandoff', 'shutdown', 'initialization failure'] as const)(
    'routes %s through the recorded containment reaper',
    async (terminalPath) => {
      if (terminalPath === 'idle retirement') vi.useFakeTimers();
      const server = createFakeProviderServerHandle({ containmentIdentity: containment });
      const reapContainment = vi.fn(async () => {});
      const initializationError = new Error('fixture initialization failed');
      const spawnProviderServer: SpawnProviderServerFn =
        terminalPath === 'initialization failure'
          ? vi.fn(async (...args: Parameters<SpawnProviderServerFn>) => {
              args[3]?.(containment);
              throw initializationError;
            })
          : createSpawnProviderServerMock(server.handle);
      const manager = new StubbedContainmentProviderHostManager({
        runtime,
        spawnProviderServer,
        idleTimeoutMs: 10,
        reapContainment,
      });
      const spec = createSharedSpec();

      if (terminalPath === 'initialization failure') {
        await expect(manager.openSession(spec)).rejects.toBe(initializationError);
      } else {
        const opened = await manager.openSession(spec);
        if (terminalPath === 'idle retirement') {
          opened.close();
          server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
          await vi.advanceTimersByTimeAsync(10);
        } else if (terminalPath === 'eviction') {
          await manager.evictHost(opened.hostRef);
        } else if (terminalPath === 'drainForHandoff') {
          await manager.drainForHandoff();
        } else {
          await manager.shutdown();
        }
      }

      expect(reapContainment).toHaveBeenCalledOnce();
      expect(reapContainment).toHaveBeenCalledWith(containment);
      await manager.shutdown();
      expect(reapContainment).toHaveBeenCalledOnce();
    },
  );

  it('retires idle host bookkeeping on process death even when containment reaping fails', async () => {
    vi.useFakeTimers();
    const reapFailure = new Error('fixture containment reap failed');
    const firstReap = createDeferred<void>();
    const reapContainment = vi
      .fn<(identity: RecordedContainmentIdentity) => Promise<void>>()
      .mockImplementationOnce(async () => firstReap.promise)
      .mockResolvedValue(undefined);
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const server = createFakeProviderServerHandle({ generation: 491 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      idleTimeoutMs: 10,
      reapContainment,
    });
    const spec = createSharedSpec({
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      idleRetirement: 'unleased',
    });
    const lease = await manager.openSession(spec);
    const entry = [...(manager as unknown as { entries: Map<string, ProviderHostEntry> }).entries.values()][0];
    if (entry === undefined) throw new Error('provider host entry was not installed');

    lease.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(reapContainment).toHaveBeenCalledWith(server.handle.containmentIdentity);
    const failedOperation = entry.closePromise;
    if (failedOperation === null) throw new Error('idle retirement did not start a close operation');

    server.resolveClosed();
    expect(manager.listProviderHosts()).toEqual([]);
    await server.handle.closePromise;
    await Promise.resolve();

    expect(entry.handle).toBeNull();
    expect(entry.instanceId).toBeNull();
    expect(entry.containment).toBe(server.handle.containmentIdentity);
    expect(manager.admissionSnapshot().state.size).toBe(0);
    expect(manager.admissionSnapshot().tombstones).toEqual([]);
    expect(manager.listProviderHosts()).toEqual([]);

    const observedFailure = failedOperation.catch((error: unknown) => error);
    firstReap.reject(reapFailure);
    await expect(observedFailure).resolves.toBe(reapFailure);
    await Promise.resolve();

    expect(errorLog.mock.calls).toEqual([
      [
        `Provider host close/reap failed: provider=codex pid=${server.handle.pid} pgid=${server.handle.containmentIdentity.processGroupId} detail=idle timeout expired`,
        reapFailure,
      ],
    ]);
    expect(entry.handle).toBeNull();
    expect(entry.instanceId).toBeNull();
    expect(entry.containment).toBe(server.handle.containmentIdentity);
    expect(manager.admissionSnapshot().state.size).toBe(0);
    expect(manager.listProviderHosts()).toEqual([]);

    await manager.shutdown();
    expect(reapContainment).toHaveBeenCalledTimes(2);
    expect(entry.containment).toBeNull();
  });
});
