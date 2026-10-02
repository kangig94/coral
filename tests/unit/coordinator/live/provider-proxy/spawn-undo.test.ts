import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildGuardianSpawnUndo } from '#src/coordinator/live/provider-proxy/spawn-undo.js';
import { type GuardianIdentity, type ProxyIdentity, type ReaperIdentity } from '#src/provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const guardian: GuardianIdentity = {
  guardianInstanceId: '11111111-1111-4111-8111-111111111111',
  pid: 101,
  incarnation: testIncarnation(101),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '22222222-2222-4222-8222-222222222222',
  hostFingerprint: 'a'.repeat(64),
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const reaper: ReaperIdentity = {
  reaperInstanceId: '33333333-3333-4333-8333-333333333333',
  pid: 102,
  incarnation: testIncarnation(102),
  guardianInstanceId: guardian.guardianInstanceId,
  generation: guardian.generation,
  flavor: guardian.flavor,
  buildSetId: guardian.buildSetId,
  hostFingerprint: guardian.hostFingerprint,
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-process-group',
};

const proxy: ProxyIdentity = {
  proxyInstanceId: '44444444-4444-4444-8444-444444444444',
  guardianInstanceId: guardian.guardianInstanceId,
  reaperInstanceId: reaper.reaperInstanceId,
  pid: 103,
  incarnation: testIncarnation(103),
  processGroupId: 103,
  generation: guardian.generation,
  flavor: guardian.flavor,
  buildSetId: guardian.buildSetId,
  hostFingerprint: guardian.hostFingerprint,
  canonicalEndpoint: '/tmp/proxy.sock',
};

type GuardianTestChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: null;
  stdout: null;
  stderr: null;
  kill(signal?: NodeJS.Signals): boolean;
};

function guardianSpawnWithEvents(): Readonly<{ child: GuardianTestChild; spawned: SpawnedRoleProcess }> {
  const child: GuardianTestChild = Object.assign(new EventEmitter(), {
    pid: guardian.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => true,
  });
  const childProcess: ChildProcessLike = child;
  return {
    child,
    spawned: {
      kind: 'spawned',
      child: childProcess,
      pid: guardian.pid,
      incarnation: guardian.incarnation,
      spawnFailed: new Promise<never>(() => {}),
    },
  };
}

describe('guardian spawn undo', () => {
  it('holds the transferred proxy group without signaling the guardian when attribution is lost', async () => {
    const kill = vi.fn(() => true);
    let groupObservations = 0;
    const runtime = {
      process: {
        kill,
        observeLiveness: (pid: number) => {
          if (pid !== -proxy.pid) return 'alive';
          groupObservations += 1;
          return groupObservations <= 1 ? 'alive' : 'unknown';
        },
        observeRecordedProcessAsync: async () => 'alive' as const,
      },
      time: {
        monotonicNow: () => 0n,
        sleep: async () => undefined,
      },
    } as unknown as Runtime;
    const { spawned } = guardianSpawnWithEvents();
    const undo = buildGuardianSpawnUndo(runtime, spawned, 'linux', (pid) =>
      pid === proxy.pid ? proxy.incarnation : guardian.incarnation,
    );
    undo.bindProxyIdentity(proxy);

    await expect(undo()).rejects.toThrow('proxy process-group cleanup is holding');

    expect(kill).not.toHaveBeenCalled();
  });
});
