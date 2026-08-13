// Covers LaunchCoordinator, provider host manager, provider-server transport, and durable transport concurrency.
import { describe, expect, it, vi } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createProviderHostContainmentReaper } from '#src/coordinator/live/provider-hosts/drain.js';
import { PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS } from '#src/providers/app-server-transport.js';
import { backendLog } from '#src/infra/backend-log.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

type ExclusiveProviderServerSpec = Extract<ProviderServerSpec, { leaseMode: 'job-exclusive' }>;

function createProviderServerSpec(overrides: Partial<ExclusiveProviderServerSpec> = {}): ExclusiveProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir('/tmp/sim/project'),
    leaseMode: 'job-exclusive',
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral-test' } },
    },
    ...overrides,
  };
}

function createHostLaunch(
  overrides: Partial<ExclusiveProviderServerSpec> = {},
): Parameters<DefaultProviderHostManager['openSession']>[0] {
  return createProviderServerSpec(overrides);
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

function createHostManager(
  runtime: SimulationRuntime,
  launchCoordinator: LaunchCoordinator,
): DefaultProviderHostManager {
  let elapsedMs = 0;
  const clock = createMonotonicClock(Symbol('provider-transport-concurrency'), {
    readMilliseconds: () => BigInt(elapsedMs),
    sleep: async (milliseconds) => {
      elapsedMs += milliseconds;
    },
  });
  return new DefaultProviderHostManager({
    runtime,
    spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    reapContainment: createProviderHostContainmentReaper(runtime, { clock }),
  });
}

describe('provider transport concurrency hardening', () => {
  it('rejects and kills a provider server that never answers initialize', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = createHostManager(runtime, launchCoordinator);

    const observed = observePromise(hostManager.openSession(createHostLaunch(), { jobId: 'job-a' }));
    await flushMicrotasks();

    runtime.time.tick(PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(observed.settled).toBe(false);
    expect(runtime.spawner.killCalls).toEqual([{ pid: -20_000, signal: 0 }]);

    runtime.time.tick(1);
    await flushMicrotasks(200);

    expect(observed.settled).toBe(true);
    expect(observed.error).toBeInstanceOf(Error);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: -20_000, signal: 'SIGTERM' });
    expect(runtime.spawner.killCalls).not.toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
  });

  it('honors a provider-specific initialize timeout', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = createHostManager(runtime, launchCoordinator);

    const observed = observePromise(
      hostManager.openSession(createHostLaunch({ initializeTimeoutMs: 250 }), { jobId: 'job-a' }),
    );
    await flushMicrotasks();

    runtime.time.tick(249);
    await flushMicrotasks();
    expect(observed.settled).toBe(false);

    runtime.time.tick(1);
    await flushMicrotasks(200);

    expect(observed.settled).toBe(true);
    expect((observed.error as Error | undefined)?.message).toContain('initialize timed out after 250ms');
    expect(runtime.spawner.killCalls).toContainEqual({ pid: -20_000, signal: 'SIGTERM' });
    expect(runtime.spawner.killCalls).not.toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
  });

  it('falls back to the default initialize timeout for invalid provider timeout values', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = createHostManager(runtime, launchCoordinator);

    const observed = observePromise(
      hostManager.openSession(createHostLaunch({ initializeTimeoutMs: 0 }), { jobId: 'job-a' }),
    );
    await flushMicrotasks();

    runtime.time.tick(PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(observed.settled).toBe(false);

    runtime.time.tick(1);
    await flushMicrotasks(200);

    expect(observed.settled).toBe(true);
    expect((observed.error as Error | undefined)?.message).toContain(
      `initialize timed out after ${PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS}ms`,
    );
    expect(runtime.spawner.killCalls).toContainEqual({ pid: -20_000, signal: 'SIGTERM' });
    expect(runtime.spawner.killCalls).not.toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
  });

  it('does not spawn a provider server when acquire is already aborted', async () => {
    const runtime = new SimulationRuntime();
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = createHostManager(runtime, launchCoordinator);
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);

    await expect(
      hostManager.openSession(createHostLaunch({ initializeRequest: undefined }), {
        jobId: 'job-a',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ stage: 'provider_host_acquire', reason });
    expect(runtime.spawner.spawnCalls).toHaveLength(0);
  });

  it('threads acquire abort into provider-server initialize and kills the child', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const hostManager = createHostManager(runtime, launchCoordinator);
    const controller = new AbortController();

    const observed = observePromise(
      hostManager.openSession(createHostLaunch(), { jobId: 'job-a', signal: controller.signal }),
    );
    await flushMicrotasks();

    controller.abort(new Error('acquire aborted'));
    await flushMicrotasks(20);

    expect(observed.settled).toBe(true);
    expect(observed.error).toBeInstanceOf(Error);
    expect(runtime.spawner.killCalls).toContainEqual({ pid: -20_000, signal: 'SIGTERM' });
    expect(runtime.spawner.killCalls).not.toContainEqual({ pid: 20_000, signal: 'SIGTERM' });
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
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('notification handler failed'), expect.any(Error));
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
