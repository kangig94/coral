import type { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import {
  spawnProviderServerTransport,
  type ProviderContainmentAcceptance,
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
  it('keeps an unreadable detached spawn joined until its close is observed', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(null);
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('unknown');
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    expect(observation.settled).toBe(false);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 20_000, signal: 'SIGTERM' });

    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    expect(observation.settled).toBe(false);

    child.close();
    await expect(launch).rejects.toMatchObject({ code: 'process_identity_unverified' });
  });

  it('keeps an uncontained failed initialization joined until its close is observed', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('unknown');
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);
    const abort = new AbortController();

    const launch = spawnProviderServerTransport({
      runtime,
      options: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        initializeRequest: { method: 'initialize', params: {} },
        signal: abort.signal,
      },
      generation: 1,
      observeProviderResponse: () => {},
    });
    const observation = observePromise(launch);
    await flushMicrotasks();
    abort.abort(new Error('cancelled'));
    await flushMicrotasks();

    expect(observation.settled).toBe(false);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 20_000, signal: 'SIGTERM' });

    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    expect(observation.settled).toBe(false);

    child.close();
    await expect(launch).rejects.toMatchObject({ stage: 'provider codex initialize' });
  });

  it('keeps failed piped-handle setup joined until its close is observed', async () => {
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
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    expect(observation.settled).toBe(false);
    child.close();
    await expect(launch).rejects.toThrow(/piped stdio handles/u);
  });

  it('keeps a pid-less spawn joined until its close is observed', async () => {
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
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    expect(observation.settled).toBe(false);
    child.close();
    await expect(launch).rejects.toThrow(/pid is unavailable/u);
  });

  it('keeps containment locally owned when the proposed owner refuses it', async () => {
    const runtime = new SimulationRuntime();
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('unknown');
    const child = delayedClose();
    runtime.spawner.enqueueSpawn(child.script);

    const launch = spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'codex', args: ['app-server'] },
      generation: 1,
      observeProviderResponse: () => {},
      detached: true,
      recordContainment: (() => Symbol('refused')) as unknown as () => ProviderContainmentAcceptance,
    });
    const observation = observePromise(launch);
    await flushMicrotasks();

    expect(observation.settled).toBe(false);
    child.close();
    await expect(launch).rejects.toThrow(/did not accept/u);
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
    });

    child.error(new Error('synthetic child error'));
    await expect(handle.closePromise).resolves.toBeInstanceOf(Error);
    const close = handle.close();
    const observation = observePromise(close);
    await flushMicrotasks();
    expect(observation.settled).toBe(false);

    child.close();
    await expect(close).resolves.toBeUndefined();
  });
});
