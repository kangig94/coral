import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import {
  closeProviderServerEntry,
  createProviderHostContainmentReaper,
  shutdownHandle,
} from '#src/coordinator/live/provider-hosts/drain.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { RecordedContainmentIdentity } from '#src/infra/process-containment.js';

import { createDeferred } from '#tools/testing/deferred.js';
import {
  createEntry,
  createFakeProviderServerHandle,
  createSharedSpec,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const containment: RecordedContainmentIdentity = Object.freeze({
  pid: 481,
  incarnation: testIncarnation(1_700_000_481),
  processGroupId: 481,
});

function createRecordingReaper(incarnation = containment.incarnation, leaderAlive = true) {
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
          (pid === containment.pid && leaderAlive) || (pid === -containment.processGroupId && groupAlive)
            ? 'alive'
            : 'absent',
        observeRecordedProcessAsync: async (owner) =>
          leaderAlive && owner.pid === containment.pid && owner.incarnation === incarnation ? 'alive' : 'absent',
        observeProcessIdentities: async (owners) =>
          owners.map((owner) => ({
            owner,
            evidence:
              leaderAlive && owner.pid === containment.pid
                ? { kind: 'incarnation' as const, incarnation }
                : { kind: 'pid-absent' as const },
          })),
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === 'SIGKILL') groupAlive = false;
          return true;
        },
      },
    },
    {
      clock,
      readProcessIncarnation: (pid) => (leaderAlive && pid === containment.pid ? incarnation : null),
    },
  );
  return { reaper, signals };
}

async function closeRecordedEntry(
  reaper: ReturnType<typeof createRecordingReaper>['reaper'],
): Promise<ReturnType<typeof createFakeProviderServerHandle>> {
  const server = createFakeProviderServerHandle({ containmentIdentity: containment });
  Object.assign(server.handle.child, { exitCode: null, signalCode: null });
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

  it('signals the recorded negative process group with TERM then KILL for coordinator-local host close', async () => {
    const recording = createRecordingReaper();

    const server = await closeRecordedEntry(recording.reaper);

    expect(recording.signals).toEqual([
      [-containment.processGroupId, 'SIGTERM'],
      [-containment.processGroupId, 'SIGKILL'],
    ]);
    expect(server.closeMock, 'child-only gracefulKill teardown was used').not.toHaveBeenCalled();
  });

  it('uses the retained provider child to authorize Darwin teardown', async () => {
    let elapsedMs = 0;
    let groupAlive = true;
    const signals: Array<readonly [number, NodeJS.Signals | 0]> = [];
    const clock = createMonotonicClock(Symbol('darwin-provider-host-reaper-test'), {
      readMilliseconds: () => BigInt(elapsedMs),
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    });
    const server = createFakeProviderServerHandle({
      generation: containment.pid,
      containmentIdentity: containment,
    });
    Object.assign(server.handle.child, { exitCode: null, signalCode: null });
    const readProcessIncarnation = vi.fn(() => null);
    const reaper = createProviderHostContainmentReaper(
      {
        env: { ...runtime.env, platform: () => 'darwin' },
        process: {
          ...runtime.process,
          observeLiveness: (pid) => (pid === -containment.processGroupId && groupAlive ? 'alive' : 'absent'),
          observeRecordedProcessAsync: async () => (groupAlive ? 'unknown' : 'absent'),
          kill: (pid, signal) => {
            signals.push([pid, signal]);
            groupAlive = false;
            server.resolveClosed();
            return true;
          },
        },
      },
      { clock, readProcessIncarnation },
    );

    expect(server.handle.isClosed()).toBe(false);
    await shutdownHandle(server.handle, createSharedSpec(), containment, runtime.time, reaper);

    expect(signals).toEqual([[-containment.processGroupId, 'SIGTERM']]);
    expect(readProcessIncarnation).not.toHaveBeenCalled();
    expect(server.finishCloseAfterReapMock).toHaveBeenCalledOnce();
  });

  it('does not treat an open transport as live-child authority after the leader exit was collected', async () => {
    const recording = createRecordingReaper(containment.incarnation, false);
    const server = createFakeProviderServerHandle({ containmentIdentity: containment });
    Object.assign(server.handle.child, { exitCode: 0, signalCode: null });

    expect(server.handle.isClosed()).toBe(false);
    await expect(
      shutdownHandle(server.handle, createSharedSpec(), containment, runtime.time, recording.reaper),
    ).rejects.toMatchObject({ code: 'process_identity_unverified' });
    expect(recording.signals).toEqual([]);
    expect(server.finishCloseAfterReapMock).not.toHaveBeenCalled();
  });

  it('retains a broker shutdown hold until its retry reports child cleanup absent', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        disposition: 'held-unobservable',
        observation: 'unobservable',
        subjects: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
        successor: { kind: 'accepted', owner: 'broker-session-pool' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      })
      .mockResolvedValueOnce({ ok: true, disposition: 'observed-absent' });
    const server = createFakeProviderServerHandle({ containmentIdentity: containment, request });
    const reaper = vi.fn(async () => undefined);
    const spec = createSharedSpec({
      shutdownCapability: {
        method: 'broker/shutdown',
        timeoutMs: 1_000,
        resultDisposition: {
          kind: 'provider-server-shutdown-v1',
          successorOwner: 'broker-session-pool',
          operatorExit: 'retry-broker-shutdown',
        },
      },
    });

    const held = await shutdownHandle(server.handle, spec, containment, runtime.time, reaper);
    expect(held).toMatchObject({
      kind: 'provider-shutdown-held-unobservable',
      obligations: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
      successor: { kind: 'accepted', owner: 'broker-session-pool' },
      operatorExit: { kind: 'retry-broker-shutdown', retry: expect.any(Function) },
    });
    expect(reaper).not.toHaveBeenCalled();
    expect(server.finishCloseAfterReapMock).not.toHaveBeenCalled();
    if (held.kind === 'observed-absent') throw new Error('Expected a retained broker shutdown hold.');

    await expect(held.operatorExit.retry()).resolves.toEqual({ kind: 'observed-absent' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(reaper).toHaveBeenCalledOnce();
    expect(server.finishCloseAfterReapMock).toHaveBeenCalledOnce();
  });

  it('refuses to signal a recycled recorded process group without retained child authority', async () => {
    const recording = createRecordingReaper(testIncarnation('recycled'));

    // A leader incarnation that no longer matches proves the pid was reused, not that the surviving group is
    // gone. Signalling it would signal someone else's group, and reporting the close as done would retire a
    // host this build cannot account for, so the only remaining answer is to refuse and keep the entry.
    await expect(recording.reaper(containment)).rejects.toMatchObject({
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
          observeRecordedProcessAsync: async (owner) =>
            owner.pid === containment.pid && owner.incarnation === containment.incarnation ? 'alive' : 'absent',
          observeProcessIdentities: async (owners) =>
            owners.map((owner) => ({
              owner,
              evidence:
                owner.pid === containment.pid
                  ? { kind: 'incarnation' as const, incarnation: containment.incarnation }
                  : { kind: 'pid-absent' as const },
            })),
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
});
