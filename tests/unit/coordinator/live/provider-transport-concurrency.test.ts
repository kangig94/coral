// Covers LaunchCoordinator, provider host manager, provider-server transport, and durable transport concurrency.
import { describe, expect, it, vi } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS } from '#src/coordinator/live/provider-server-transport.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function createProviderServerSpec(overrides: Partial<ProviderServerSpec> = {}): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: '/tmp/sim/project',
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral-test' } },
    },
    ...overrides,
  };
}

function observePromise<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const observed: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then(
    (value) => {
      observed.settled = true;
      observed.value = value;
    },
    (error: unknown) => {
      observed.settled = true;
      observed.error = error;
    },
  );
  return observed;
}

describe('provider transport concurrency hardening', () => {
  it('rejects and kills a provider server that never answers initialize', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    });

    const observed = observePromise(hostManager.acquireServer(createProviderServerSpec()));
    await flushMicrotasks();

    runtime.time.tick(PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(observed.settled).toBe(false);
    expect(runtime.spawner.killCalls).toEqual([]);

    runtime.time.tick(1);
    await flushMicrotasks(20);

    expect(observed.settled).toBe(true);
    expect(observed.error).toBeInstanceOf(Error);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
  });

  it('threads acquire abort into provider-server initialize and kills the child', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    });
    const controller = new AbortController();

    const observed = observePromise(
      hostManager.acquireServer(createProviderServerSpec(), { signal: controller.signal }),
    );
    await flushMicrotasks();

    controller.abort(new Error('acquire aborted'));
    await flushMicrotasks(20);

    expect(observed.settled).toBe(true);
    expect(observed.error).toBeInstanceOf(Error);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
  });

  it('faults the provider transport instead of rethrowing notification handler errors', async () => {
    const runtime = new SimulationRuntime();
    const logError = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    runtime.spawner.enqueueSpawn({
      close: null,
      onSpawn: ({ child, schedule }) => {
        schedule(1, () => {
          child.pushStdout(`${JSON.stringify({ method: 'tick', params: { ready: true } })}\n`);
        });
      },
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const handle = await launchCoordinator.spawnProviderServer({
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
    });

    handle.onNotification(() => {
      throw new Error('consumer queue full');
    });

    expect(() => runtime.time.tick(1)).not.toThrow();
    await flushMicrotasks();

    expect(runtime.spawner.killCalls).toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('notification handler failed'),
      expect.any(Error),
    );
    await expect(handle.closePromise).resolves.toBeInstanceOf(Error);
  });

  it('kills a durable child that finishes launching after terminateAll already drained cleanup handles', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueDurable({
      pid: 30_001,
      runtimeDelayMs: 5,
      exit: null,
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });

    void launchCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/sim/jobs/late-durable',
      permitGranted: true,
    });
    await flushMicrotasks();

    launchCoordinator.terminateAll();
    runtime.time.tick(5);
    await flushMicrotasks();

    expect(runtime.spawner.killCalls).toContainEqual({ pid: 30_001, signal: 'SIGTERM' });
  });
});
