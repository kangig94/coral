import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/coordinator/live/provider-proxy/role-control.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, establishRoleControl: vi.fn() };
});

vi.mock('#src/coordinator/live/provider-proxy/heartbeat.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return { ...original, createProviderProxyAuthorityHeartbeatAssembly: vi.fn() };
});

import { redeemProviderProxyControl } from '#src/coordinator/live/provider-proxy/control-redemption.js';
import {
  createProviderProxyAuthorityHeartbeatAssembly,
  type ProviderProxyRoleHeartbeats,
} from '#src/coordinator/live/provider-proxy/heartbeat.js';
import {
  establishRoleControl,
  ProviderProxyRoleControlRemoteError,
  ProviderProxyRoleControlUnavailableError,
} from '#src/coordinator/live/provider-proxy/role-control.js';
import { ControlClientError, type ControlClient } from '#src/provider-proxy/control-client.js';
import type { HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import type { CoordinatorIdentity, OperationIdentity } from '#src/provider-proxy/protocol.js';
import { ESTABLISH_CONTROL_READY_DEADLINE_MS } from '#src/coordinator/live/provider-proxy/role-control.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const setIdentity: ProviderProxySetIdentity = {
  buildSetId: randomUUID(),
  hostFingerprint: 'a'.repeat(64),
  guardianInstanceId: randomUUID(),
  guardianPid: 101,
  guardianIncarnation: testIncarnation(1),
  guardianControlEndpoint: '/tmp/guardian.sock',
  proxyInstanceId: randomUUID(),
  proxyPid: 202,
  reaperInstanceId: randomUUID(),
  reaperPid: 303,
  reaperIncarnation: testIncarnation(2),
  reaperControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'posix-group',
  proxyIncarnation: testIncarnation(3),
  proxyProcessGroupId: 202,
  canonicalEndpoint: '/tmp/proxy.sock',
};

const coordinatorIdentity: CoordinatorIdentity = {
  instanceId: randomUUID(),
  pid: 404,
  incarnation: testIncarnation(4),
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: setIdentity.buildSetId,
};

const capsule = {
  version: 3,
  grantId: randomUUID(),
  secret: 'redemption-secret',
  guardianControlEndpoint: setIdentity.guardianControlEndpoint,
  reaperControlEndpoint: setIdentity.reaperControlEndpoint,
  proxyEndpoint: setIdentity.canonicalEndpoint,
  hostFingerprint: setIdentity.hostFingerprint,
  buildSetId: setIdentity.buildSetId,
  proxyInstanceId: setIdentity.proxyInstanceId,
} as HandoffCapsuleV3;

const operations: readonly OperationIdentity[] = [
  {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: setIdentity.proxyInstanceId,
    buildSetId: setIdentity.buildSetId,
  },
];

const guardianIdentity = {
  guardianInstanceId: setIdentity.guardianInstanceId,
  pid: setIdentity.guardianPid,
  incarnation: setIdentity.guardianIncarnation,
  generation: coordinatorIdentity.generation,
  flavor: coordinatorIdentity.flavor,
  buildSetId: setIdentity.buildSetId,
  hostFingerprint: setIdentity.hostFingerprint,
  canonicalControlEndpoint: setIdentity.guardianControlEndpoint,
};

const reaperIdentity = {
  reaperInstanceId: setIdentity.reaperInstanceId,
  pid: setIdentity.reaperPid,
  incarnation: setIdentity.reaperIncarnation,
  guardianInstanceId: setIdentity.guardianInstanceId,
  generation: coordinatorIdentity.generation,
  flavor: coordinatorIdentity.flavor,
  buildSetId: setIdentity.buildSetId,
  hostFingerprint: setIdentity.hostFingerprint,
  canonicalControlEndpoint: setIdentity.reaperControlEndpoint,
  containmentKind: setIdentity.containmentKind,
};

const proxyIdentity = {
  proxyInstanceId: setIdentity.proxyInstanceId,
  pid: setIdentity.proxyPid,
  incarnation: setIdentity.proxyIncarnation,
  processGroupId: setIdentity.proxyProcessGroupId,
  guardianInstanceId: setIdentity.guardianInstanceId,
  reaperInstanceId: setIdentity.reaperInstanceId,
  generation: coordinatorIdentity.generation,
  flavor: coordinatorIdentity.flavor,
  buildSetId: setIdentity.buildSetId,
  hostFingerprint: setIdentity.hostFingerprint,
  canonicalEndpoint: setIdentity.canonicalEndpoint,
};

function fakeClient(): ControlClient {
  return { close: vi.fn() } as unknown as ControlClient;
}

function sessions(proxy = proxyIdentity) {
  return [
    {
      client: fakeClient(),
      opened: {
        controlEpoch: 11,
        heartbeatChallenge: 'guardian-first',
        state: 'redeemed-provisional' as const,
        redemptionReceipt: 'guardian-receipt',
        operations,
        guardian: guardianIdentity,
        reaper: reaperIdentity,
        containment: {
          pid: setIdentity.proxyPid,
          incarnation: setIdentity.proxyIncarnation,
          processGroupId: setIdentity.proxyProcessGroupId,
          containmentKind: setIdentity.containmentKind,
        },
      },
      nextHeartbeatChallenge: 'guardian-next',
    },
    {
      client: fakeClient(),
      opened: {
        controlEpoch: 12,
        heartbeatChallenge: 'reaper-first',
        state: 'successor-rotated' as const,
        reaperRotationReceipt: 'reaper-receipt',
        operations,
        reaper: reaperIdentity,
      },
      nextHeartbeatChallenge: 'reaper-next',
    },
    {
      client: fakeClient(),
      opened: {
        controlEpoch: 13,
        heartbeatChallenge: 'proxy-first',
        state: 'redeemed-provisional' as const,
        redemptionReceipt: 'proxy-receipt',
        operations,
        proxy,
      },
      nextHeartbeatChallenge: 'proxy-next',
    },
  ] as const;
}

const mockedEstablishRoleControl = vi.mocked(establishRoleControl);
const mockedHeartbeatAssembly = vi.mocked(createProviderProxyAuthorityHeartbeatAssembly);
const heartbeatStop = vi.fn();
const heartbeats = {
  guardian: { stop: heartbeatStop },
  reaper: { stop: heartbeatStop },
  proxy: { stop: heartbeatStop },
} as unknown as ProviderProxyRoleHeartbeats;
const startRole = vi.fn();
const complete = vi.fn(() => heartbeats);
const stop = vi.fn();

function runtimeWithNow(now: () => number = () => 1_000): Runtime {
  const runtime = createRealRuntime('prod');
  return { ...runtime, time: { ...runtime.time, now } };
}

function arrangeSessions(proxy = proxyIdentity): void {
  const [guardian, reaper, providerProxy] = sessions(proxy);
  mockedEstablishRoleControl.mockResolvedValueOnce(guardian as never);
  mockedEstablishRoleControl.mockResolvedValueOnce(reaper as never);
  mockedEstablishRoleControl.mockResolvedValueOnce(providerProxy as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedEstablishRoleControl.mockReset();
  mockedHeartbeatAssembly.mockReturnValue({ startRole, complete, stop });
});

describe('provider proxy control redemption', () => {
  it('redeems in proof order under one absolute deadline and carries the guardian receipt into rotation', async () => {
    arrangeSessions();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_250)
      .mockReturnValueOnce(1_500)
      .mockReturnValue(1_500);

    const outcome = await redeemProviderProxyControl(
      capsule,
      setIdentity,
      { runtime: runtimeWithNow(now), coordinatorIdentity },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('redeemed');
    const calls = mockedEstablishRoleControl.mock.calls;
    expect(calls.map((call) => call[3].role)).toEqual(['guardian', 'reaper', 'proxy']);
    expect(calls.map((call) => call[3].openMethod)).toEqual([
      'guardian.handoff-redeem.v1',
      'reaper.handoff-rotate.v1',
      'handoff.redeem.v1',
    ]);
    expect(calls[0][3].openParams).toMatchObject({ successor: coordinatorIdentity });
    expect(calls[1][3].openParams).toMatchObject({ guardianRedemptionReceipt: 'guardian-receipt' });
    expect(calls[2][3].openParams).toMatchObject({ successor: coordinatorIdentity });
    expect(calls.map((call) => call[2].overallDeadlineMs)).toEqual([
      ESTABLISH_CONTROL_READY_DEADLINE_MS,
      ESTABLISH_CONTROL_READY_DEADLINE_MS - 250,
      ESTABLISH_CONTROL_READY_DEADLINE_MS - 500,
    ]);
    expect(startRole.mock.calls.map((call) => call[0])).toEqual(['guardian', 'reaper', 'proxy']);
  });

  it('refuses a complete reply whose returned identity is not the requested set identity', async () => {
    arrangeSessions({ ...proxyIdentity, proxyInstanceId: randomUUID() });

    const outcome = await redeemProviderProxyControl(
      capsule,
      setIdentity,
      { runtime: runtimeWithNow(), coordinatorIdentity },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'refused', refusal: { kind: 'identity-disagreement' } });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps a decisive role refusal distinct from an unavailable role', async () => {
    const remote = new ProviderProxyRoleControlRemoteError(
      'guardian',
      'open',
      'guardian.handoff-redeem.v1',
      new ControlClientError('control_call_failed', 'grant_invalid', 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32_000,
        protocolCode: 'grant_invalid',
        admissionReason: null,
        heartbeatRefusal: null,
      }),
    );
    mockedEstablishRoleControl.mockRejectedValueOnce(remote);
    const refused = await redeemProviderProxyControl(
      capsule,
      setIdentity,
      { runtime: runtimeWithNow(), coordinatorIdentity },
      new AbortController().signal,
    );

    const unavailableError = new ProviderProxyRoleControlUnavailableError({
      kind: 'role-control-unavailable',
      role: 'guardian',
      stage: 'connect',
      method: null,
      origin: 'timeout',
      controlCode: 'control_client_connect_failed',
    });
    mockedEstablishRoleControl.mockRejectedValueOnce(unavailableError);
    const unavailable = await redeemProviderProxyControl(
      capsule,
      setIdentity,
      { runtime: runtimeWithNow(), coordinatorIdentity },
      new AbortController().signal,
    );

    expect(refused.kind).toBe('refused');
    expect(unavailable.kind).toBe('unavailable');
  });
});
