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
  it('escalates a still-alive pre-control group and confirms its absence', async () => {
    let deliveredSignal: NodeJS.Signals | null = null;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal !== 0) deliveredSignal = signal;
      return true;
    });
    let monotonicNow = 0n;
    const runtime = {
      process: {
        kill,
        observeLiveness: (pid: number) => (pid === -guardian.pid && deliveredSignal === 'SIGKILL' ? 'absent' : 'alive'),
        observeRecordedProcessAsync: async () => 'alive' as const,
      },
      time: {
        monotonicNow: () => monotonicNow,
        sleep: async (ms: number) => {
          monotonicNow += BigInt(ms);
        },
      },
    } as unknown as Runtime;
    const undo = buildGuardianSpawnUndo(
      runtime,
      { pid: guardian.pid, incarnation: guardian.incarnation } as SpawnedRoleProcess,
      'linux',
      () => guardian.incarnation,
    );

    await expect(undo()).resolves.toBeUndefined();

    expect(kill.mock.calls).toEqual([
      [-guardian.pid, 'SIGTERM'],
      [-guardian.pid, 'SIGKILL'],
    ]);
  });

  it('holds without escalating when the group cannot be re-observed after SIGTERM', async () => {
    const kill = vi.fn(() => true);
    let groupObservations = 0;
    const runtime = {
      process: {
        kill,
        observeLiveness: (pid: number) => {
          if (pid !== -guardian.pid) return 'alive';
          groupObservations += 1;
          return groupObservations <= 2 ? 'alive' : 'unknown';
        },
        observeRecordedProcessAsync: async () => 'alive' as const,
      },
      time: {
        monotonicNow: () => 0n,
        sleep: async () => undefined,
      },
    } as unknown as Runtime;
    const undo = buildGuardianSpawnUndo(
      runtime,
      { pid: guardian.pid, incarnation: guardian.incarnation } as SpawnedRoleProcess,
      'linux',
      () => guardian.incarnation,
    );

    await expect(undo()).rejects.toThrow(
      'guardian process-group cleanup is holding because absence could not be confirmed',
    );

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-guardian.pid, 'SIGTERM');
  });

  it('keeps the control recovery channel open after a teardown refusal without sending a signal', async () => {
    const kill = vi.fn();
    const runtime = {
      process: { kill },
      time: { now: () => 0, sleep: async () => undefined },
    } as unknown as Runtime;
    const close = vi.fn();
    const exchange = vi
      .fn<ControlClient['exchange']>()
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'result',
            value: { state: 'teardown-latched-absence-unconfirmed', reason: 'containment is unattributable' },
          },
        }),
      )
      .mockResolvedValueOnce(
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'containment-absent', disappearanceReceipt: 'gone' } },
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
      spawnGuardian: async () => ({
        kind: 'guardian-containment',
        label: 'guardian',
        run: undo,
        guardianIdentity: undo.guardianIdentity,
      }),
      establishControl: async () => {
        throw new Error('publication failed');
      },
    };

    const result = await acquireProviderProxySet({
      steps,
      deadlineSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: 'provider_proxy_acquisition_held',
      cut: 'control establishment',
      strandedArtifacts: ['guardian'],
      guardianIdentity: undo.guardianIdentity,
    });
    expect(exchange).toHaveBeenCalledWith(
      'guardian.containment-commit.v1',
      { guardian, reaper, proxy },
      expect.any(Number),
    );
    expect(close).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    if (result.kind !== 'provider_proxy_acquisition_held') throw new Error(`expected hold, received ${result.kind}`);
    await expect(result.recoveryCapability.retry(new AbortController().signal)).resolves.toEqual({
      kind: 'absence-confirmed',
      strandedArtifacts: [],
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
