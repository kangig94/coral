import { describe, expect, it, vi } from 'vitest';

import {
  acquireProviderProxySet,
  type ProviderProxyAcquisitionSteps,
} from '#src/coordinator/live/provider-proxy/index.js';
import { buildGuardianSpawnUndo } from '#src/coordinator/live/provider-proxy/spawn-undo.js';
import { controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import type { GuardianIdentity, ProxyIdentity, ReaperIdentity } from '#src/provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '#src/provider-proxy/role-spawn.js';
import type { Runtime } from '#src/runtime/ports.js';
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

describe('guardian spawn undo', () => {
  it('reports an unconfirmed pre-control SIGTERM without treating it as completed cleanup', async () => {
    const kill = vi.fn();
    let now = 0;
    const runtime = {
      process: { kill, observeLiveness: () => 'unknown' },
      time: {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    } as unknown as Runtime;
    const undo = buildGuardianSpawnUndo(
      runtime,
      { pid: guardian.pid, incarnation: guardian.incarnation } as SpawnedRoleProcess,
      'linux',
      () => guardian.incarnation,
    );

    await expect(undo()).rejects.toThrow('guardian process-group absence was not confirmed after SIGTERM');

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-guardian.pid, 'SIGTERM');
  });

  it('reports a control-plane teardown refusal as a stranded guardian without sending a signal', async () => {
    const kill = vi.fn();
    const runtime = {
      process: { kill },
      time: { now: () => 0, sleep: async () => undefined },
    } as unknown as Runtime;
    const close = vi.fn();
    const exchange = vi.fn(async () =>
      controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'result',
          value: { state: 'teardown-latched-absence-unconfirmed', reason: 'containment is unattributable' },
        },
      }),
    );
    const client = {
      exchange,
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close,
    } satisfies ControlClient;
    const undo = buildGuardianSpawnUndo(
      runtime,
      { pid: guardian.pid, incarnation: guardian.incarnation } as SpawnedRoleProcess,
      'linux',
      () => guardian.incarnation,
    );
    undo.bindControl({ client, guardian, reaper, proxy });
    const steps: ProviderProxyAcquisitionSteps = {
      createCapsules: async () => ({ label: 'capsules', run: () => undefined }),
      spawnGuardian: async () => ({ label: 'guardian', run: undo }),
      establishControl: async () => {
        throw new Error('publication failed');
      },
    };

    const result = await acquireProviderProxySet({
      steps,
      deadlineSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_failed',
      cut: 'control establishment',
      strandedArtifacts: ['guardian'],
    });
    expect(exchange).toHaveBeenCalledWith(
      'guardian.containment-commit.v1',
      { guardian, reaper, proxy },
      expect.any(Number),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });
});
