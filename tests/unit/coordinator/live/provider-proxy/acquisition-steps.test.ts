import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('#src/provider-proxy/bootstrap-capsule.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, createProviderBootstrapCapsule: vi.fn() };
});

vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    spawnRoleProcess: vi.fn(() => ({ pid: 101, processStartedAtSeconds: 11 })),
  };
});

vi.mock('#src/coordinator/live/provider-proxy/role-control.js', () => ({
  establishRoleControl: vi.fn(),
}));

vi.mock('#src/coordinator/live/provider-proxy/set-authority.js', () => ({
  createProviderProxySetAuthority: vi.fn(),
}));

import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import { isProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { establishRoleControl } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import type { CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

const mockedEstablishRoleControl = vi.mocked(establishRoleControl);
const mockedCreateSetAuthority = vi.mocked(createProviderProxySetAuthority);

function passiveClient(): ControlClient {
  return {
    call: async () => ({ state: 'active', nextHeartbeatChallenge: 'next' }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
}

describe('createProviderProxyAcquisitionSteps', () => {
  it('removes fresh authority when the reaper heartbeat genuinely rejects', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const clients = {
      proxy: passiveClient(),
      guardian: passiveClient(),
      reaper: passiveClient(),
    };
    let reaperHeartbeats = 0;
    clients.reaper.call = async () => {
      reaperHeartbeats += 1;
      throw new Error('reaper heartbeat rejected');
    };
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role as keyof typeof clients;
      const client = clients[role];
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, processStartedAtSeconds: 21, processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, processStartedAtSeconds: 31 }
            : plan.expectedIdentity;
      return {
        client,
        opened: {
          controlEpoch: role === 'proxy' ? 1 : role === 'guardian' ? 2 : 3,
          heartbeatChallenge: `${role}-first`,
          [role]: identity,
        },
        nextHeartbeatChallenge: `${role}-next`,
      } as never;
    });
    mockedCreateSetAuthority.mockImplementation((options) => ({
      proxyInstanceId: options.proxyInstanceId,
      stopHeartbeats: () => {
        options.heartbeats.proxy.stop();
        options.heartbeats.guardian.stop();
        options.heartbeats.reaper.stop();
      },
      stopAndReap: () => new Promise<never>(() => undefined),
      initiateControlClose: async () => undefined,
      installRecoveryCredential: async () => undefined,
      registerSuccessionOperation: async () => undefined,
    }));
    const coordinatorIdentity: CoordinatorIdentity = {
      instanceId: randomUUID(),
      pid: 1,
      processStartedAtSeconds: 1,
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: randomUUID(),
    };
    const steps = createProviderProxyAcquisitionSteps({
      runtime,
      pluginRoot: '/tmp/coral-acquisition-test',
      baseDir: '/tmp/coral-acquisition-test',
      coordinatorIdentity,
      hostFingerprint: 'a'.repeat(64),
      operationRegistry: { operationsFor: () => [], providerRootsFor: () => [] },
    });
    await steps.createCapsules();
    await steps.spawnGuardian();
    const established = await steps.establishControl();
    if (!isProviderProxyOperationAuthority(established.set)) throw new Error('expected durable authority');
    const set = established.set;
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      disappearanceConsumer: {
        containmentDisappeared: async (notice) => ({
          kind: 'accepted',
          operation: notice.operation,
          disposition: 'record-absent',
        }),
      },
      time,
      proveContainmentAbsent: async () => null,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const routeKey = 'fresh-reaper-heartbeat';
    const admission = lifecycle.beginFreshAcquisition(routeKey);
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);
    lifecycle.acquisitionSucceeded(admission.slotId, set);
    expect(lifecycle.routeFor(routeKey)).toBe(set);

    time.tick(1_000);
    await flushMicrotasks();

    const observation = {
      reaperHeartbeats,
      routeAvailable: lifecycle.routeFor(routeKey) !== null,
    };
    set.stopHeartbeats();
    await set.initiateControlClose();
    expect(observation).toEqual({ reaperHeartbeats: 1, routeAvailable: false });
  });
});
