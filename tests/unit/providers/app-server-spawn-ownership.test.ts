import type { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import {
  spawnProviderServerTransport,
  type ProviderContainmentAcceptance,
  type ProviderServerFailedSpawnCleanupAcceptor,
  type ProviderServerHandle,
} from '#src/providers/app-server-transport.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

type PromiseObservation<T> = { settled: boolean; value?: T; error?: unknown };

function observePromise<T>(promise: Promise<T>): PromiseObservation<T> {
  const observation: PromiseObservation<T> = { settled: false };
  void promise.then(
    (value) => {
      observation.settled = true;
      observation.value = value;
    },
    (error: unknown) => {
      observation.settled = true;
      observation.error = error;
    },
  );
  return observation;
}

const acceptCleanupHold: ProviderServerFailedSpawnCleanupAcceptor = (hold) => ({
  kind: 'accepted',
  owner: 'provider-proxy-root-pool',
  settlement: hold.settled,
});
const acceptCloseHold: Parameters<ProviderServerHandle['close']>[0] = (hold) => ({
  kind: 'accepted',
  owner: 'provider-proxy-root-pool',
  settlement: hold.settled,
});

const failContainmentRecording = (): ProviderContainmentAcceptance => {
  throw new Error('synthetic containment recording failure');
};

function delayedClose(onSpawned?: (child: unknown) => void): Readonly<{
  script: {
    close: null;
    kills: [{ signal: 'default'; delayMs: number }];
    onSpawn: (context: {
      child: unknown;
      close(outcome?: { code?: number | null; signal?: string | null }): void;
    }) => void;
  };
  close(): void;
  error(error: Error): void;
}> {
  let closeSpawned = (): void => {
    throw new Error('Provider process was not spawned.');
  };
  let errorSpawned = (_error: Error): void => {
    throw new Error('Provider process was not spawned.');
  };
  return {
    script: {
      close: null,
      kills: [{ signal: 'default', delayMs: 100_000 }],
      onSpawn: (context) => {
        onSpawned?.(context.child);
        closeSpawned = () => context.close({ code: 0, signal: 'SIGTERM' });
        errorSpawned = (error) => (context.child as EventEmitter).emit('error', error);
      },
    },
    close: () => closeSpawned(),
    error: (error) => errorSpawned(error),
  };
}

describe('provider app-server spawn ownership', () => {
  it('uses retained child authority to clean an unreadable detached spawn on Darwin', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.env, 'platform').mockReturnValue('darwin');
    const readProcessIncarnation = vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(null);
    let processGroupAlive = true;
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) =>
      pid < 0 && processGroupAlive ? 'alive' : 'absent',
    );
    const kill = vi.spyOn(runtime.process, 'kill').mockImplementation((pid) => {
      if (pid === -20_000) processGroupAlive = false;
      return true;
    });
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    await expect(launch).rejects.toMatchObject({ code: 'process_identity_unverified' });
    expect(readProcessIncarnation).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-20_000, 'SIGTERM');
    child.close();
  });

  it('joins an active exception-cleanup retry before operator abandonment settles', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('alive');
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
      acceptFailedSpawnCleanup: acceptCleanupHold,
      recordContainment: failContainmentRecording,
    });
    await flushMicrotasks();
    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    runtime.time.tick(SIGKILL_GRACE_MS);
    const held = await launch;
    if (!('kind' in held) || held.kind !== 'held-alive') throw new Error('Expected a live process-group hold.');

    const sigkillsBeforeRetry = runtime.spawner.killCalls.filter(({ signal }) => signal === 'SIGKILL').length;
    const retry = held.retry();
    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    const abandonment = held.operatorExit.abandon();
    const abandonmentObservation = observePromise(abandonment);
    expect(abandonmentObservation.settled).toBe(false);
    await expect(abandonment).resolves.toMatchObject({ kind: 'operator-abandoned' });
    await expect(retry).resolves.toMatchObject({ kind: 'operator-abandoned' });

    runtime.time.tick(SIGTERM_GRACE_MS + SIGKILL_GRACE_MS);
    await flushMicrotasks();
    expect(runtime.spawner.killCalls.filter(({ signal }) => signal === 'SIGKILL')).toHaveLength(sigkillsBeforeRetry);
    child.close();
  });

  it('returns an accepted attached piped-handle hold without waiting for child close', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('unknown');
    const child = delayedClose((spawned) => {
      (spawned as { stdout: null }).stdout = null;
    });
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    const held = await launch;
    expect(observation.settled).toBe(true);
    expect(held).toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'process', pid: 20_000 },
      error: expect.objectContaining({ message: expect.stringMatching(/piped stdio handles/u) }),
    });
    if (!('kind' in held) || held.kind !== 'held-unobservable') {
      throw new Error('Expected an attached process cleanup hold.');
    }
    child.close();
    await held.settled;
  });

  it('returns an operator-actionable hold for an unattributable detached spawn', async () => {
    const runtime = new SimulationRuntime();
    const child = delayedClose((spawned) => {
      (spawned as { pid: number | undefined }).pid = undefined;
    });
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    const held = await launch;
    expect(held).toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'unattributable-process-group', processGroupId: null },
      operatorExit: { kind: 'abandon-provider-host-acquisition' },
    });
    if (!('kind' in held) || held.kind !== 'held-unobservable') {
      throw new Error('Expected an unattributable process-group hold.');
    }
    child.close();
    await expect(held.operatorExit.abandon()).resolves.toEqual({
      kind: 'operator-abandoned',
      subject: { kind: 'unattributable-process-group', processGroupId: null },
      processAbsenceProven: false,
      successor: { owner: 'operator-command', acceptance: 'accepted' },
    });
  });

  it('keeps containment locally owned while a recording exception is cleaned up', async () => {
    const runtime = new SimulationRuntime();
    let processGroupAlive = true;
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) =>
      pid < 0 && processGroupAlive ? 'alive' : 'absent',
    );
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
      acceptFailedSpawnCleanup: acceptCleanupHold,
      recordContainment: failContainmentRecording,
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    runtime.time.tick(SIGKILL_GRACE_MS);
    const held = await launch;
    expect(observation.settled).toBe(true);
    if (!('kind' in held) || (held.kind !== 'held-alive' && held.kind !== 'held-unobservable')) {
      throw new Error('Expected containment recording failure to return an accepted cleanup hold.');
    }
    const groupSettlement = observePromise(held.settled);
    child.close();
    await flushMicrotasks();
    expect(groupSettlement.settled).toBe(false);
    processGroupAlive = false;
    const absence = held.retry();
    runtime.time.tick(SIGTERM_GRACE_MS);
    await expect(absence).resolves.toMatchObject({ kind: 'observed-absent' });
    await expect(held.settled).resolves.toBeUndefined();
  });

  it('does not let a logical child error discharge handle close', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('unknown');
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);
    const handle = await spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    if ('kind' in handle) throw new Error('Expected a provider server handle.');

    child.error(new Error('synthetic child error'));
    await expect(handle.closePromise).resolves.toBeInstanceOf(Error);
    const close = handle.close(acceptCloseHold);
    const observation = observePromise(close);
    await flushMicrotasks();
    expect(observation.settled).toBe(true);

    const held = await close;
    expect(held).toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'process', pid: 20_000 },
      successor: { kind: 'accepted', owner: 'provider-proxy-root-pool' },
    });
    if (held.kind !== 'held-unobservable') throw new Error('Expected an attached process close hold.');
    const settlement = observePromise(held.settled);
    expect(settlement.settled).toBe(false);

    child.close();
    await held.settled;
  });
});
