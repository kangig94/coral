import { testIncarnation } from '#tests/helpers/process-incarnation.js';
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
    spawnRoleProcess: vi.fn(() => ({ pid: 101, incarnation: testIncarnation(11) })),
  };
});

vi.mock('#src/coordinator/live/provider-proxy/role-control.js', () => ({
  establishRoleControl: vi.fn(),
}));

vi.mock('#src/coordinator/live/provider-proxy/set-authority.js', () => ({
  createProviderProxySetAuthority: vi.fn(),
}));

import { createProviderProxyAcquisitionSteps } from '#src/coordinator/live/provider-proxy/acquisition-steps.js';
import {
  isProviderProxyOperationAuthority,
  notifyProviderProxyControlEstablished,
  subscribeProviderProxyControlEstablished,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { establishRoleControl } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createProviderProxySetAuthority } from '#src/coordinator/live/provider-proxy/set-authority.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { connectControlClient, ControlClientError } from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { ControlLeaseEvidence } from '#src/provider-proxy/control-lease.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import type { CoordinatorIdentity } from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

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

async function proxyLeaseSession(time: VirtualTime) {
  const socketPath = `/tmp/coral-acquisition-heartbeat-${randomUUID()}.sock`;
  const scope = Symbol('acquisition-heartbeat');
  const clock = createMonotonicClock(scope, { readMilliseconds: () => BigInt(time.now()) });
  const lease = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, clock.now());
  let challengeNumber = 0;
  let acceptedEchoes = 0;
  const mintChallenge = () => `acquisition-challenge-${challengeNumber++}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => {
      const challenge = mintChallenge();
      return lease.issueFirstChallenge(challenge)
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'already-issued' };
    },
    admitSuccessor: () => ({ accepted: false, reason: 'not-used' }),
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => lease.isControlLive(clock.now()),
    echoChallenge: (challenge) => {
      const nextChallenge = mintChallenge();
      const result = lease.echoChallenge(clock.now(), challenge, nextChallenge);
      if (!result.accepted) return result;
      acceptedEchoes += 1;
      return { accepted: true, nextChallenge };
    },
  };
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'control.heartbeat.v1',
      methods: new Map([
        [
          'role.open.v1',
          { authority: 'establishes-control' as const, handle: async () => ({ holder: 'coordinator', fields: {} }) },
        ],
      ]),
    },
    challenges,
    observer: { onControlLost: () => undefined },
    timer: time,
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  const client = await connectControlClient(socketPath, time, 5_000);
  const opened = (await client.call('role.open.v1', {}, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  const first = (await client.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  )) as { nextHeartbeatChallenge: string };
  const watchdog = time.setInterval(() => {
    if (!lease.isControlLive(clock.now())) void endpoint.close();
  }, 1_000);
  return {
    client,
    opened,
    nextHeartbeatChallenge: first.nextHeartbeatChallenge,
    acceptedEchoes: () => acceptedEchoes,
    controlIsLive: () => lease.isControlLive(clock.now()),
    close: async () => {
      time.clearInterval(watchdog);
      client.close();
      await endpoint.close();
    },
  };
}

async function advanceEndpointClock(
  time: VirtualTime,
  durationMs: number,
  heartbeatOriginMs: number,
  acceptedEchoes: () => number,
): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    const step = Math.min(1_000, remaining);
    time.tick(step);
    remaining -= step;
    const expectedEchoes = 1 + Math.floor((time.now() - heartbeatOriginMs) / PROXY_CONTROL_HEARTBEAT_MS);
    if (acceptedEchoes() < expectedEchoes) {
      await vi.waitFor(() => expect(acceptedEchoes()).toBe(expectedEchoes));
    }
  }
}

describe('createProviderProxyAcquisitionSteps', () => {
  it('keeps proxy control live while guardian and reaper each consume 8500ms', async () => {
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod'), time };
    const proxy = await proxyLeaseSession(time);
    const guardian = passiveClient();
    const reaper = passiveClient();
    const heartbeatOriginMs = time.now();
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role;
      if (role === 'guardian') await advanceEndpointClock(time, 8_500, heartbeatOriginMs, proxy.acceptedEchoes);
      if (role === 'reaper') await advanceEndpointClock(time, 8_500, heartbeatOriginMs, proxy.acceptedEchoes);
      const client = role === 'proxy' ? proxy.client : role === 'guardian' ? guardian : reaper;
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, incarnation: testIncarnation(21), processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, incarnation: testIncarnation(31) }
            : plan.expectedIdentity;
      return {
        client,
        opened: {
          controlEpoch: role === 'proxy' ? proxy.opened.controlEpoch : role === 'guardian' ? 2 : 3,
          heartbeatChallenge: `${role}-first`,
          [role]: identity,
        },
        nextHeartbeatChallenge: role === 'proxy' ? proxy.nextHeartbeatChallenge : `${role}-next`,
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
      incarnation: testIncarnation(1),
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

    const observation = { recurringEchoes: proxy.acceptedEchoes() - 1, controlIsLive: proxy.controlIsLive() };
    established.set.stopHeartbeats();
    await established.set.initiateControlClose();
    await proxy.close();
    expect({
      acceptedRecurringEchoes: observation.recurringEchoes > 1,
      controlIsLive: observation.controlIsLive,
    }).toEqual({ acceptedRecurringEchoes: true, controlIsLive: true });
  });

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
      throw new ControlClientError(
        'control_call_failed',
        'Heartbeat echo was not accepted (teardown-latched).',
        'remote-response',
        {
          kind: 'json-rpc-error',
          jsonRpcCode: -32600,
          protocolCode: 'invalid_request',
          admissionReason: null,
          heartbeatRefusal: { reason: 'teardown-latched', nextHeartbeatChallenge: null },
        },
      );
    };
    mockedEstablishRoleControl.mockImplementation(async (opened, _timer, _retry, plan) => {
      const role = plan.role;
      const client = clients[role];
      opened.push(client);
      const identity =
        role === 'proxy'
          ? { ...plan.expectedIdentity, pid: 201, incarnation: testIncarnation(21), processGroupId: 201 }
          : role === 'reaper'
            ? { ...plan.expectedIdentity, pid: 301, incarnation: testIncarnation(31) }
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
      incarnation: testIncarnation(1),
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
    const establishedEvents = vi.fn();
    const unsubscribe = subscribeProviderProxyControlEstablished(establishedEvents);
    const established = await steps.establishControl();
    if (!isProviderProxyOperationAuthority(established.set)) throw new Error('expected durable authority');

    // The address the real writer produced, checked here because this is the only place it is produced. The
    // generation lives in the filename precisely so a v0.10.8 build never opens what this build writes, and a
    // capsule handed to the authority under the wrong name is that build refusing to boot. Asserting the
    // suffix that v0.10.8's own discovery pattern cannot match is the whole property.
    expect(mockedCreateSetAuthority.mock.calls[0]?.[0]?.handoffCapsulePath).toMatch(
      /\/provider-1[0-9a-f]{23}\.handoff\.v3\.json$/u,
    );
    const set = established.set;
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: notifyProviderProxyControlEstablished,
      time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'containment-proof': async () => null,
        'disappearance-consumer': async ({ notice }) => ({
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
        }),
      }),
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    const routeKey = 'fresh-reaper-heartbeat';
    const admission = lifecycle.beginFreshAcquisition(routeKey);
    if (admission.kind !== 'accepted') throw new Error(`fresh set was not admitted: ${admission.kind}`);
    lifecycle.acquisitionSucceeded(admission.slotId, set);
    expect(lifecycle.routeFor(routeKey)).toBe(set);
    expect(establishedEvents).toHaveBeenCalledTimes(1);

    time.tick(1_000);
    await flushMicrotasks();

    const observation = {
      reaperHeartbeats,
      routeAvailable: lifecycle.routeFor(routeKey) !== null,
    };
    set.stopHeartbeats();
    await set.initiateControlClose();
    unsubscribe();
    expect(observation).toEqual({ reaperHeartbeats: 1, routeAvailable: false });
  });
});
