import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { ChildProcessLike } from '#src/infra/port-types.js';
import { spawnRoleProcess, type RoleSpawnOptions, type RoleSpawnPorts } from '#src/provider-proxy/role-spawn.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';

/** A minimal `ChildProcessLike` built on a real `EventEmitter`, so `.on('error', ...)`/emitting `'error'`
 *  behave exactly as they do on a genuine Node child: no listener at emit time would throw. `ChildProcessLike`
 *  itself declares no `emit`, so the emitter is kept alongside the cast view rather than cast away with it. */
function createFakeChild(pid: number | undefined): {
  child: ChildProcessLike;
  killSignals: NodeJS.Signals[];
  unref: ReturnType<typeof vi.fn>;
  emitClose(): void;
  emitError(error: Error): void;
} {
  const killSignals: NodeJS.Signals[] = [];
  const emitter = new EventEmitter();
  const unref = vi.fn();
  const exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const child = Object.assign(emitter, {
    pid,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    stdin: null,
    stdout: null,
    stderr: null,
    unref,
    kill: (signal?: NodeJS.Signals) => {
      killSignals.push(signal ?? 'SIGTERM');
      return true;
    },
  }) as unknown as ChildProcessLike;
  return {
    child,
    killSignals,
    unref,
    emitClose: () => {
      signalCode = 'SIGTERM';
      emitter.emit('exit', exitCode, signalCode);
      emitter.emit('close', exitCode, signalCode);
    },
    emitError: (error) => emitter.emit('error', error),
  };
}

type FakePortsOptions = Readonly<{
  spawn(options: RuntimeSpawnOptions): ChildProcessLike;
  runtime?: Runtime;
  readProcessIncarnation?(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
}>;

// A real runtime, not a fake: `gracefulKill`'s own escalation timer needs a genuine `Runtime`, and its
// SIGKILL timer is unref'd and never awaited here, so it never actually fires within a test's lifetime.
const realRuntime = createRealRuntime('prod');

function fakePorts(options: FakePortsOptions): RoleSpawnPorts {
  return {
    process: { spawn: options.spawn },
    runtime: options.runtime ?? realRuntime,
    platform: 'linux',
    ...(options.readProcessIncarnation === undefined ? {} : { readProcessIncarnation: options.readProcessIncarnation }),
  };
}

function baseOptions(overrides: Partial<RoleSpawnOptions> = {}): RoleSpawnOptions {
  return { pluginRoot: '/plugin-root', detached: false, ...overrides };
}

describe('spawnRoleProcess', () => {
  it('never signals a detached failed spawn without identity and accepts only independent group absence', async () => {
    const { child, emitClose, unref } = createFakeChild(6_002);
    let groupLiveness: 'alive' | 'absent' = 'alive';
    const observeLiveness = vi.fn((pid: number) => (pid === -6_002 ? groupLiveness : 'absent'));
    const kill = vi.fn(() => true);
    const runtime: Runtime = {
      ...realRuntime,
      time: { ...realRuntime.time, sleep: vi.fn(async () => {}) },
      process: { ...realRuntime.process, kill, observeLiveness },
    };
    const ports = fakePorts({ spawn: () => child, runtime, readProcessIncarnation: () => null });

    const disposition = spawnRoleProcess('guardian', '/capsule.json', ports, baseOptions({ detached: true }));
    if (disposition.kind !== 'held') throw new Error('Expected unreadable detached role spawn to be held');
    let settled = false;
    void disposition.settled.then(() => {
      settled = true;
    });
    emitClose();
    await Promise.resolve();
    expect(settled).toBe(false);

    const firstCleanup = await disposition.retry();
    expect(firstCleanup).toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'unattributable-process-group', processGroupId: 6_002 },
      observation: 'unobservable',
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      retry: expect.any(Function),
    });
    expect(observeLiveness).toHaveBeenCalledWith(-6_002);
    expect(kill).not.toHaveBeenCalled();
    expect(unref).not.toHaveBeenCalled();

    if (firstCleanup.kind !== 'held-unobservable') throw new Error('Expected the surviving group to remain held');
    groupLiveness = 'absent';
    await expect(firstCleanup.retry()).resolves.toMatchObject({
      kind: 'observed-absent',
      evidence: {
        subject: { kind: 'unattributable-process-group', processGroupId: 6_002 },
        processGroupEvidence: {
          subject: { kind: 'process-group', processGroupId: 6_002 },
        },
      },
    });
    await expect(disposition.settled).resolves.toBeUndefined();
  });
});
