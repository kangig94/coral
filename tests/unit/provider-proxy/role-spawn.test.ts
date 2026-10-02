import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { ChildProcessLike } from '#src/infra/port-types.js';
import {
  requireSpawnedRole,
  RoleSpawnError,
  spawnRoleProcess,
  type RoleSpawnOptions,
  type RoleSpawnPorts,
} from '#src/provider-proxy/role-spawn.js';
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
  it('returns a pid-less child hold without hiding its close-backed settlement', async () => {
    const { child, killSignals, unref, emitClose } = createFakeChild(undefined);
    const ports = fakePorts({ spawn: () => child });

    const disposition = spawnRoleProcess('proxy', '/capsule.json', ports, baseOptions());
    expect(disposition).toMatchObject({
      kind: 'held',
      error: expect.objectContaining({ code: 'role_spawn_no_pid', role: 'proxy' }),
      settled: expect.any(Promise),
      retry: expect.any(Function),
    });
    if (disposition.kind !== 'held') throw new Error('Expected pid-less role spawn to be held');
    expect(unref).not.toHaveBeenCalled();
    expect(disposition.error).toBeInstanceOf(RoleSpawnError);
    expect(killSignals).toEqual([]);

    await expect(disposition.retry()).resolves.toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'process', pid: null },
      observation: 'unobservable',
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      settled: disposition.settled,
      retry: expect.any(Function),
    });
    await expect(disposition.retry()).resolves.toMatchObject({ kind: 'held-unobservable' });
    expect(killSignals).toEqual(['SIGTERM']);
    let closeSettled = false;
    void disposition.settled.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    emitClose();
    await disposition.settled;
    await expect(disposition.retry()).resolves.toMatchObject({
      kind: 'observed-absent',
      evidence: { subject: { kind: 'process', pid: null } },
    });
  });

  it('returns an unobservable hold when the process probe cannot answer', async () => {
    const { child, killSignals, unref, emitClose } = createFakeChild(6_001);
    const runtime = {
      ...realRuntime,
      process: {
        ...realRuntime.process,
        observeLiveness: () => 'unknown' as const,
      },
    };
    const ports = fakePorts({
      spawn: () => child,
      runtime,
      readProcessIncarnation: () => {
        throw new Error('synthetic process probe failure');
      },
    });

    const disposition = spawnRoleProcess('guardian', '/capsule.json', ports, baseOptions());
    expect(disposition).toMatchObject({
      kind: 'held',
      child,
      error: expect.objectContaining({ code: 'role_spawn_incarnation_unavailable', role: 'guardian' }),
      settled: expect.any(Promise),
      retry: expect.any(Function),
    });
    if (disposition.kind !== 'held') throw new Error('Expected throwing role probe to be held');
    expect(unref).not.toHaveBeenCalled();
    expect(disposition.error).toBeInstanceOf(RoleSpawnError);
    expect(killSignals).toEqual([]);

    await expect(disposition.retry()).resolves.toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'process', pid: 6_001 },
      observation: 'unobservable',
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      settled: disposition.settled,
      retry: expect.any(Function),
    });
    expect(killSignals).toContain('SIGTERM');

    emitClose();
    await expect(disposition.retry()).resolves.toMatchObject({
      kind: 'observed-absent',
      evidence: { subject: { kind: 'process', pid: 6_001 } },
    });
  });

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

  it('surfaces an unattributable detached spawn hold and its acquisition-abandonment exit', async () => {
    const { child, emitClose } = createFakeChild(undefined);
    const disposition = spawnRoleProcess(
      'guardian',
      '/capsule.json',
      fakePorts({ spawn: () => child }),
      baseOptions({ detached: true }),
    );
    if (disposition.kind !== 'held') throw new Error('Expected pid-less detached role spawn to be held');
    emitClose();

    const cleanup = await disposition.retry();
    expect(cleanup).toMatchObject({
      kind: 'held-unobservable',
      subject: { kind: 'unattributable-process-group', processGroupId: null },
      observation: 'unobservable',
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      retry: expect.any(Function),
    });
    expect(disposition.operatorExit.abandon()).toEqual({
      kind: 'operator-abandoned',
      subject: { kind: 'unattributable-process-group', processGroupId: null },
      processAbsenceProven: false,
      successor: { owner: 'operator-command', acceptance: 'accepted' },
    });
    await expect(disposition.settled).resolves.toBeUndefined();
    await expect(requireSpawnedRole(disposition)).resolves.toMatchObject({
      kind: 'held',
      operatorExit: { kind: 'abandon-provider-proxy-acquisition' },
      retry: expect.any(Function),
    });
  });

  it('reports an async spawn error as a rejected spawnFailed promise, not an uncaught exception', async () => {
    const { child, emitError } = createFakeChild(7_003);
    const ports = fakePorts({ spawn: () => child, readProcessIncarnation: () => testIncarnation(1_000) });

    const spawned = spawnRoleProcess('reaper', '/capsule.json', ports, baseOptions());
    if (spawned.kind !== 'spawned') throw new Error('Expected readable role spawn to succeed');
    const failure = new Error('ENOENT: spawn failed');
    // Reaching this line at all is part of what the test proves: Node's EventEmitter re-throws an 'error'
    // emitted with no listener, so if `spawnRoleProcess` had not already attached one, this call itself would
    // throw synchronously and fail the test before the assertion below ever runs.
    emitError(failure);

    await expect(spawned.spawnFailed).rejects.toBe(failure);
  });
});
