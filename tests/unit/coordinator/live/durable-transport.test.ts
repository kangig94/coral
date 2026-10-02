import { describe, expect, it, vi } from 'vitest';
import type { JobRuntime } from '#src/jobs/records.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import {
  type ProviderServerCleanupHoldAcceptor,
  PROVIDER_SERVER_MAX_JSONL_LINE_BYTES,
} from '#src/providers/app-server-transport.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

const acceptHold: ProviderServerCleanupHoldAcceptor = (hold) => ({
  kind: 'accepted' as const,
  owner: 'provider-host-manager' as const,
  settlement: hold.settled,
});

async function advance(runtime: SimulationRuntime, milliseconds: number): Promise<void> {
  runtime.time.tick(milliseconds);
  await flushMicrotasks(64);
}

describe('durable transport', () => {
  it('streams durable-job progress and reports runtime metadata without sidecar files', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueDurable({
      stdout: [
        { delayMs: 1, data: '{"step":"one"}\n' },
        { delayMs: 25, data: '{"step":"two"}\n' },
      ],
      stderr: [{ delayMs: 35, data: 'warn\n' }],
      exit: { delayMs: 50, exitCode: 0 },
    });
    const coordinator = new LaunchCoordinator({ runtime });
    coordinator.bindActiveEpochPath('/store/epoch-1');
    const onEvent = vi.fn();
    const records: JobRuntime[] = [];
    const result = coordinator.spawnDurableJob({
      provider: 'codex',
      command: 'fixture',
      args: [],
      jobDir: '/jobs/stream',
      onEvent,
      onRuntimeRecord: (record) => {
        records.push(record);
      },
    });
    await flushMicrotasks(64);
    await advance(runtime, 500);
    await advance(runtime, 1_000);

    await expect(result).resolves.toMatchObject({
      code: 0,
      aborted: false,
      stdout: '{"step":"one"}\n{"step":"two"}\n',
      stderr: 'warn\n',
    });
    expect(onEvent.mock.calls).toEqual([['{"step":"one"}'], ['{"step":"two"}']]);
    expect(records.at(-1)).toMatchObject({ tailWatermark: expect.any(Number) });
    expect(runtime.storage.existsSync('/jobs/stream/runtime.json')).toBe(false);
    expect(runtime.storage.existsSync('/jobs/stream/exit.json')).toBe(false);
  });

  it('holds the provider result until an unattributable surviving descendant exits', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueDurable({ exit: { delayMs: 1, exitCode: 0 } });
    let descendantAlive = true;
    const observeLiveness = runtime.process.observeLiveness;
    runtime.process.observeLiveness = (pid) => (pid === -20_000 && descendantAlive ? 'alive' : observeLiveness(pid));
    const coordinator = new LaunchCoordinator({ runtime });
    coordinator.bindActiveEpochPath('/store/epoch-1');
    let completed = false;
    const result = coordinator.spawnDurableJob({
      provider: 'codex',
      command: 'fixture',
      args: [],
      jobDir: '/jobs/descendant',
    });
    void result.then(() => {
      completed = true;
    });
    await flushMicrotasks(64);
    await advance(runtime, 500);
    expect(runtime.process.observeLiveness(20_001)).toBe('absent');
    expect(runtime.process.observeLiveness(-20_000)).toBe('alive');
    expect(completed).toBe(false);

    descendantAlive = false;
    await advance(runtime, 500);
    await advance(runtime, 1_000);
    await expect(result).resolves.toMatchObject({ code: 0 });
    expect(completed).toBe(true);
  });

  it('closes provider servers that emit an oversized JSONL line', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null, stdout: 'x'.repeat(PROVIDER_SERVER_MAX_JSONL_LINE_BYTES + 1) });
    const coordinator = new LaunchCoordinator({ runtime });
    const handle = await coordinator.spawnProviderServer(
      { provider: 'codex', command: 'fixture', args: [] },
      undefined,
      undefined,
      undefined,
      acceptHold,
    );
    if ('kind' in handle) throw new Error('expected provider server');
    await advance(runtime, 1);
    await expect(handle.closePromise).resolves.toMatchObject({
      data: { code: 'provider_server_line_too_large', maxLineBytes: PROVIDER_SERVER_MAX_JSONL_LINE_BYTES },
    });
  });

  it('closes provider servers that emit a malformed JSON-RPC message', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null, stdout: '{}\n' });
    const coordinator = new LaunchCoordinator({ runtime });
    const handle = await coordinator.spawnProviderServer(
      { provider: 'codex', command: 'fixture', args: [] },
      undefined,
      undefined,
      undefined,
      acceptHold,
    );
    if ('kind' in handle) throw new Error('expected provider server');
    await advance(runtime, 1);
    await expect(handle.closePromise).resolves.toMatchObject({
      message: expect.stringContaining('malformed JSON-RPC message'),
    });
  });

  it('staged launch termination drains queued launches but does not kill provider servers', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ close: null });
    const coordinator = new LaunchCoordinator({ runtime });
    const handle = await coordinator.spawnProviderServer(
      { provider: 'codex', command: 'fixture', args: [] },
      undefined,
      undefined,
      undefined,
      acceptHold,
    );
    if ('kind' in handle) throw new Error('expected provider server');
    await coordinator.settlePendingLaunches();
    await expect(coordinator.terminateRegisteredChildren()).resolves.toEqual({ kind: 'all-children-observed-absent' });
    expect(handle.isClosed()).toBe(false);
    expect(runtime.process.observeLiveness(handle.pid)).toBe('alive');
    await handle.close(acceptHold);
  });
});
