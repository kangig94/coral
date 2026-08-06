import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ChildProcessLike } from '#src/infra/port-types.js';
import {
  RoleSpawnError,
  spawnRoleProcess,
  type RoleSpawnOptions,
  type RoleSpawnPorts,
} from '#src/provider-proxy/role-spawn.js';
import type { RuntimeSpawnOptions } from '#src/runtime/ports.js';

/**
 * `spawnRoleProcess` has no dedicated coverage anywhere else: `process-topology.integration.test.ts` drives
 * it only through the full role-main topology, which never exercises the failure branches (`role_spawn_no_pid`,
 * an unreadable start time), the two `resolveBackendArtifact` branches, or the exact shape of the spawn call
 * itself. A regression dropping `envAdditions` — the flavor env a spawned peer needs to find the right
 * capsule — would pass every existing test.
 */

/** A minimal `ChildProcessLike` built on a real `EventEmitter`, so `.on('error', ...)`/emitting `'error'`
 *  behave exactly as they do on a genuine Node child: no listener at emit time would throw. `ChildProcessLike`
 *  itself declares no `emit`, so the emitter is kept alongside the cast view rather than cast away with it. */
function createFakeChild(pid: number | undefined): {
  child: ChildProcessLike;
  killSignals: NodeJS.Signals[];
  emitError(error: Error): void;
} {
  const killSignals: NodeJS.Signals[] = [];
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: (signal?: NodeJS.Signals) => {
      killSignals.push(signal ?? 'SIGTERM');
      return true;
    },
  }) as unknown as ChildProcessLike;
  return { child, killSignals, emitError: (error) => emitter.emit('error', error) };
}

type FakePortsOptions = Readonly<{
  spawn(options: RuntimeSpawnOptions): ChildProcessLike;
  readProcessStartedAtSeconds?(pid: number, platform: NodeJS.Platform): number | null;
}>;

function fakePorts(options: FakePortsOptions): RoleSpawnPorts {
  return {
    process: { spawn: options.spawn },
    // Never actually fires: the escalation this feeds only matters for a *live* child a failed spawn's
    // cleanup is signalling, which none of these tests need to wait out.
    time: { setTimeout: () => ({ unref: () => undefined }), clearTimeout: () => undefined },
    platform: 'linux',
    ...(options.readProcessStartedAtSeconds === undefined
      ? {}
      : { readProcessStartedAtSeconds: options.readProcessStartedAtSeconds }),
  };
}

function baseOptions(overrides: Partial<RoleSpawnOptions> = {}): RoleSpawnOptions {
  return { pluginRoot: '/plugin-root', detached: false, ...overrides };
}

describe('spawnRoleProcess', () => {
  it('kills the child and throws role_spawn_no_pid when spawn returns no pid', () => {
    const { child, killSignals } = createFakeChild(undefined);
    const ports = fakePorts({ spawn: () => child });

    expect(() => spawnRoleProcess('proxy', '/capsule.json', ports, baseOptions())).toThrow(RoleSpawnError);
    try {
      spawnRoleProcess('proxy', '/capsule.json', ports, baseOptions());
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'role_spawn_no_pid', role: 'proxy' });
    }
    expect(killSignals).toContain('SIGTERM');
  });

  it('kills the child and throws role_spawn_start_time_unavailable when the start time cannot be read', () => {
    const { child, killSignals } = createFakeChild(6_000);
    const ports = fakePorts({ spawn: () => child, readProcessStartedAtSeconds: () => null });

    expect(() => spawnRoleProcess('reaper', '/capsule.json', ports, baseOptions())).toThrow(RoleSpawnError);
    try {
      spawnRoleProcess('reaper', '/capsule.json', ports, baseOptions());
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'role_spawn_start_time_unavailable', role: 'reaper' });
    }
    expect(killSignals).toContain('SIGTERM');
  });

  it('reuses the current entrypoint when it is already coral-backend.cjs', () => {
    const captured: RuntimeSpawnOptions[] = [];
    const ports = fakePorts({
      spawn: (options) => {
        captured.push(options);
        return createFakeChild(7_000).child;
      },
      readProcessStartedAtSeconds: () => 1_000,
    });

    spawnRoleProcess(
      'guardian',
      '/capsule.json',
      ports,
      baseOptions({ currentEntrypoint: '/some/install/path/coral-backend.cjs' }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.args[0]).toBe('/some/install/path/coral-backend.cjs');
  });

  it('resolves the entrypoint under the plugin root bridge when not already running as the artifact', () => {
    const captured: RuntimeSpawnOptions[] = [];
    const ports = fakePorts({
      spawn: (options) => {
        captured.push(options);
        return createFakeChild(7_001).child;
      },
      readProcessStartedAtSeconds: () => 1_000,
    });

    spawnRoleProcess('guardian', '/capsule.json', ports, baseOptions({ currentEntrypoint: '/some/other/entry.js' }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.args[0]).toBe(join('/plugin-root', 'bridge', 'coral-backend.cjs'));
  });

  it('passes command, cwd, and envAdditions through to the spawn call unmodified', () => {
    const captured: RuntimeSpawnOptions[] = [];
    const ports = fakePorts({
      spawn: (options) => {
        captured.push(options);
        return createFakeChild(7_002).child;
      },
      readProcessStartedAtSeconds: () => 1_000,
    });
    // The exact env a spawned peer needs to find the capsule identity meant for it — dropping this silently
    // would still pass a test that only checks the spawn was called at all.
    const envAdditions = { CORAL_BUILD_FLAVOR: 'prod' };

    spawnRoleProcess(
      'proxy',
      '/capsule.json',
      ports,
      baseOptions({ command: '/custom/node', envAdditions, pluginRoot: '/a/different/plugin-root' }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.command).toBe('/custom/node');
    expect(captured[0]?.cwd).toBe('/a/different/plugin-root');
    expect(captured[0]?.envAdditions).toEqual(envAdditions);
  });

  it('reports an async spawn error as a rejected spawnFailed promise, not an uncaught exception', async () => {
    const { child, emitError } = createFakeChild(7_003);
    const ports = fakePorts({ spawn: () => child, readProcessStartedAtSeconds: () => 1_000 });

    const spawned = spawnRoleProcess('reaper', '/capsule.json', ports, baseOptions());
    const failure = new Error('ENOENT: spawn failed');
    // Reaching this line at all is part of what the test proves: Node's EventEmitter re-throws an 'error'
    // emitted with no listener, so if `spawnRoleProcess` had not already attached one, this call itself would
    // throw synchronously and fail the test before the assertion below ever runs.
    emitError(failure);

    await expect(spawned.spawnFailed).rejects.toBe(failure);
  });
});
