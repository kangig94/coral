import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createKbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

class FakeDaemonProcess extends EventEmitter implements ChildProcessLike {
  readonly pid = 91001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  close(): void {
    this.exitCode = 0;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
  }
}

function supervisorFor(child: FakeDaemonProcess) {
  const time = new VirtualTime();
  const spawn = vi.fn(() => child);
  const runtime = {
    time,
    process: { spawn, observeLiveness: () => 'alive' },
    storage: {},
    env: { get: () => undefined, coralSnapshot: () => ({}) },
    ids: {},
    paths: {},
  } as unknown as Runtime;
  const supervisor = createKbDaemonSupervisor({
    runtime,
    pluginRoot: '/plugin',
    entrypoint: '/plugin/bridge/coral-backend.cjs',
    command: '/node',
    stopTimeoutMs: 100,
  });
  return { supervisor, time, spawn };
}

describe('KB daemon teardown', () => {
  it('cancels pending reads and retains a hanging daemon until its close is observed', async () => {
    const child = new FakeDaemonProcess();
    const { supervisor, spawn } = supervisorFor(child);
    const start = supervisor.start();
    await flushMicrotasks();
    child.stdout.write(
      `${JSON.stringify({ type: 'coral.kb_daemon.ready', pid: child.pid, startedAt: 1, readyAt: 2 })}\n`,
    );
    await start;
    const projectRoot = fixtureCanonicalWorkDir('/workspace/project');
    const read = supervisor.readKb({
      method: 'readNote',
      slug: 'note',
      ctx: {
        projectRoot,
        pluginRoot: '/plugin',
        principal: { subject: 'operator', binding: { kind: 'project', root: projectRoot } },
      },
    });
    await flushMicrotasks();
    expect(supervisor.read().pendingRequests).toBe(1);

    const controller = new AbortController();
    const disposal = supervisor.dispose('shutdown', { signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    const held = await disposal;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(read).resolves.toMatchObject({ ok: false, code: 'kb_unavailable' });
    expect(supervisor.read().pendingRequests).toBe(0);
    expect(held).toMatchObject({ kind: 'holding', snapshot: { pid: child.pid } });
    if (held.kind !== 'holding') throw new Error('Expected a retained daemon');
    child.close();
    await held.retryAfter;
    await expect(held.retry()).resolves.toMatchObject({ kind: 'confirmed-absent', snapshot: { pid: null } });
    await supervisor.start();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('contains a startup failure and releases its process ownership after close', async () => {
    const child = new FakeDaemonProcess();
    Object.defineProperty(child, 'stdout', { value: null });
    const { supervisor, time } = supervisorFor(child);

    await expect(supervisor.start()).resolves.toMatchObject({ phase: 'failed', pid: child.pid });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const disposal = supervisor.dispose('startup-failed');
    await flushMicrotasks();
    time.tick(100);
    const held = await disposal;
    expect(held.kind).toBe('holding');
    if (held.kind !== 'holding') throw new Error('Expected a retained daemon');
    child.close();
    await held.retryAfter;
    await expect(held.retry()).resolves.toMatchObject({
      kind: 'confirmed-absent',
      snapshot: { phase: 'stopped', pid: null, pendingRequests: 0 },
    });
  });
});
