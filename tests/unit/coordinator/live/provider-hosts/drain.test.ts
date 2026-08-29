import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';
import { activePinCount, acquireProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import {
  closeProviderServerEntry,
  createProviderHostContainmentReaper,
  shutdownHandle,
} from '#src/coordinator/live/provider-hosts/drain.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import type { SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import type { HostRef } from '#src/providers/contract.js';
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
  incarnation: testIncarnation(1_700_000_481),
  processGroupId: 481,
});

function createRecordingReaper(incarnation = containment.incarnation) {
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
        observeLiveness: (pid) =>
          pid === containment.pid || (pid === -containment.processGroupId && groupAlive) ? 'alive' : 'absent',
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 'SIGKILL') groupAlive = false;
          return true;
        },
      },
    },
    {
      clock,
      readProcessIncarnation: (pid) => (pid === containment.pid ? incarnation : null),
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
        observeLiveness: () => 'absent' as const,
        readProcessIncarnation: () => null,
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

  it('refuses to close a recycled coordinator-local process group instead of reporting it gone', async () => {
    const recording = createRecordingReaper(testIncarnation('recycled'));

    // A leader incarnation that no longer matches proves the pid was reused, not that the surviving group is
    // gone. Signalling it would signal someone else's group, and reporting the close as done would retire a
    // host this build cannot account for, so the only remaining answer is to refuse and keep the entry.
    await expect(closeRecordedEntry(recording.reaper)).rejects.toMatchObject({
      code: 'process_identity_unverified',
    });
    expect(recording.signals).toEqual([]);
  });

  it('stops containment escalation when lifecycle cancellation aborts the reap', async () => {
    let elapsedMs = 0;
    const sleepStarted = createDeferred<void>();
    const releaseSleep = createDeferred<void>();
    const signals: Array<readonly [number, NodeJS.Signals | 0]> = [];
    const clock = createMonotonicClock(Symbol('provider-host-reaper-cancellation-test'), {
      readMilliseconds: () => BigInt(elapsedMs),
      sleep: async (milliseconds) => {
        sleepStarted.resolve();
        await releaseSleep.promise;
        elapsedMs += milliseconds;
      },
    });
    const reaper = createProviderHostContainmentReaper(
      {
        env: { ...runtime.env, platform: () => 'linux' },
        process: {
          ...runtime.process,
          observeLiveness: (pid) =>
            pid === containment.pid || pid === -containment.processGroupId ? 'alive' : 'absent',
          kill: (pid, signal) => {
            signals.push([pid, signal]);
            return true;
          },
        },
      },
      {
        clock,
        readProcessIncarnation: (pid) => (pid === containment.pid ? containment.incarnation : null),
      },
    );
    const lifecycle = new AbortController();

    const reaping = reaper(containment, lifecycle.signal).catch((error: unknown) => error);
    await sleepStarted.promise;
    expect(signals).toEqual([[-containment.processGroupId, 'SIGTERM']]);

    lifecycle.abort();
    await expect(reaping).resolves.toMatchObject({ name: 'AbortError' });
    releaseSleep.resolve();
    await Promise.resolve();
    expect(signals).toEqual([[-containment.processGroupId, 'SIGTERM']]);
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
      const carrierHostInstanceIds = new Set<string>();
      const carrierBlocksRetirement = vi.fn((hostRef: HostRef) => carrierHostInstanceIds.has(hostRef.instanceId));
      const manager = new StubbedContainmentProviderHostManager({
        carrierBlocksRetirement,
        runtime,
        spawnProviderServer,
        idleTimeoutMs: 10,
        reapContainment,
      });
      const spec = createSharedSpec();

      let openedHostRef: HostRef | null = null;
      if (terminalPath === 'initialization failure') {
        await expect(manager.openSession(spec)).rejects.toBe(initializationError);
      } else {
        const opened = await manager.openSession(spec);
        openedHostRef = opened.hostRef;
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
      expect(reapContainment).toHaveBeenCalledWith(containment, expect.any(AbortSignal));
      if (terminalPath === 'idle retirement') {
        expect(carrierBlocksRetirement).toHaveBeenCalledTimes(2);
        expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(1, openedHostRef);
        expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(2, openedHostRef);
      } else {
        expect(carrierBlocksRetirement).not.toHaveBeenCalled();
      }
      await manager.shutdown();
      expect(reapContainment).toHaveBeenCalledOnce();
    },
  );
});
