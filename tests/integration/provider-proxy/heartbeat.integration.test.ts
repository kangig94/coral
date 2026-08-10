import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderProxyAuthorityHeartbeatAssembly,
  type ProviderProxyHeartbeatSession,
  type ProviderProxyRoleHeartbeats,
} from '#src/coordinator/live/provider-proxy/heartbeat.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFault,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { ControlLeaseEvidence } from '#src/provider-proxy/control-lease.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const realTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as NodeJS.Timeout),
};

function runtimeWithTime(time: VirtualTime): Runtime {
  return { time } as unknown as Runtime;
}

function passiveClient(role: 'guardian' | 'reaper'): ControlClient {
  let challenge = 0;
  return {
    call: async () => ({ state: 'active', nextHeartbeatChallenge: `${role}-challenge-${++challenge}` }),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => undefined,
  };
}

function sessions(
  clients: { proxy: ControlClient; guardian: ControlClient; reaper: ControlClient },
  opened: {
    controlEpoch: number;
    heartbeatChallenge: string;
  },
): Record<'proxy' | 'guardian' | 'reaper', ProviderProxyHeartbeatSession> {
  return {
    proxy: {
      client: clients.proxy,
      controlEpoch: opened.controlEpoch,
      nextHeartbeatChallenge: opened.heartbeatChallenge,
      instanceId: 'proxy-1',
    },
    guardian: {
      client: clients.guardian,
      controlEpoch: 2,
      nextHeartbeatChallenge: 'guardian-challenge-0',
      instanceId: 'guardian-1',
    },
    reaper: {
      client: clients.reaper,
      controlEpoch: 3,
      nextHeartbeatChallenge: 'reaper-challenge-0',
      instanceId: 'reaper-1',
    },
  };
}

function startAll(
  heartbeatSessions: ReturnType<typeof sessions>,
  runtime: Runtime,
  faults: ReturnType<typeof createProviderProxyAuthorityFaultLatch>,
): ProviderProxyRoleHeartbeats {
  const assembly = createProviderProxyAuthorityHeartbeatAssembly(runtime, faults);
  assembly.startRole('proxy', heartbeatSessions.proxy);
  assembly.startRole('guardian', heartbeatSessions.guardian);
  assembly.startRole('reaper', heartbeatSessions.reaper);
  return assembly.complete();
}

async function openLeaseEndpoint(
  onAcceptedEcho?: (leaseIsLive: boolean) => void,
  onRejectedEcho?: (reason: string) => void,
  options: Readonly<{
    time?: VirtualTime;
    beforeEcho?: () => void;
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'coral-heartbeat-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'control.sock');
  const clockScope = Symbol('heartbeat-lease');
  let elapsed = 0n;
  const clock = createMonotonicClock(clockScope, {
    readMilliseconds: () => (options.time === undefined ? elapsed : BigInt(options.time.now())),
  });
  const lease = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, clock.now(), () => null);
  let challengeNumber = 0;
  const mintChallenge = (): string => `challenge-${challengeNumber++}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => {
      const challenge = mintChallenge();
      return lease.issueFirstChallenge(challenge, clock.now(), 'recurring')
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'already-issued' };
    },
    admitSuccessor: () => ({ accepted: false, reason: 'not-used' }),
    reattachControl: () => {
      lease.reattachControl();
      return { accepted: true };
    },
    controlIsLive: () => lease.isControlLive(clock.now()),
    echoChallenge: (challenge) => {
      options.beforeEcho?.();
      const nextChallenge = mintChallenge();
      const recorded = lease.echoChallenge(clock.now(), challenge, nextChallenge);
      if (!recorded.accepted) {
        onRejectedEcho?.(recorded.reason);
        return recorded;
      }
      onAcceptedEcho?.(lease.isControlLive(clock.now()));
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
          {
            authority: 'establishes-control' as const,
            handle: async () => ({ holder: 'coordinator', fields: {} }),
          },
        ],
      ]),
    },
    challenges,
    observer: { onControlLost: () => undefined },
    timer: options.time ?? realTimer,
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  cleanups.push(() => endpoint.close());
  const client = await connectControlClient(socketPath, options.time ?? realTimer, 5_000);
  cleanups.push(() => client.close());
  if (options.time === undefined) elapsed = 1_000n;
  else options.time.tick(1_000);
  const opened = (await client.call('role.open.v1', {}, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  return {
    client,
    opened,
    setElapsed: (milliseconds: number) => {
      elapsed = BigInt(milliseconds);
    },
    controlIsLive: () => lease.isControlLive(clock.now()),
  };
}

describe('provider proxy heartbeat against the real endpoint', () => {
  it('accepts two consecutive recurring echoes that each spend 4200ms before endpoint acceptance', async () => {
    const time = new VirtualTime();
    let heartbeatRpcCalls = 0;
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let acceptedEchoes = 0;
    const rejectedReasons: string[] = [];
    const failures: ProviderProxyAuthorityFault[] = [];
    const endpoint = await openLeaseEndpoint(
      () => {
        acceptedEchoes += 1;
      },
      (reason) => rejectedReasons.push(reason),
      { time, beforeEcho: () => time.tick(4_200) },
    );
    const client: ControlClient = {
      ...endpoint.client,
      call(method, params, timeoutMs) {
        if (method !== 'control.heartbeat.v1') return endpoint.client.call(method, params, timeoutMs);
        heartbeatRpcCalls += 1;
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        return endpoint.client.call(method, params, timeoutMs).finally(() => {
          activeCalls -= 1;
        });
      },
    };
    const clients = { proxy: client, guardian: passiveClient('guardian'), reaper: passiveClient('reaper') };
    const faultLatch = createProviderProxyAuthorityFaultLatch();
    faultLatch.onFault((fault) => failures.push(fault));
    const heartbeats = startAll(sessions(clients, endpoint.opened), runtimeWithTime(time), faultLatch);

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await vi.waitFor(() => expect(acceptedEchoes).toBe(1));
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await vi.waitFor(() => expect(acceptedEchoes + rejectedReasons.length).toBe(2));

    expect({
      acceptedEchoes,
      rejectedReasons,
      controlIsLive: endpoint.controlIsLive(),
      faults: failures.map((failure) =>
        failure.kind === 'operation-control-failed' ? failure.kind : `${failure.kind}:${failure.role}`,
      ),
      heartbeatRpcCalls,
      maxActiveCalls,
    }).toEqual({
      acceptedEchoes: 2,
      rejectedReasons: [],
      controlIsLive: true,
      faults: [],
      heartbeatRpcCalls: 2,
      maxActiveCalls: 1,
    });
    heartbeats.proxy.stop();
    heartbeats.guardian.stop();
    heartbeats.reaper.stop();
  });

  it('keeps one RPC outstanding while an accepted response spans two intervals', async () => {
    const time = new VirtualTime();
    let heartbeatRpcCalls = 0;
    let acceptedResponses = 0;
    const failures: ProviderProxyAuthorityFault[] = [];
    const rejectedReasons: string[] = [];
    let heldResponseSnapshot: { calls: number; failures: number; leaseIsLive: boolean } | null = null;
    const endpoint = await openLeaseEndpoint(
      (leaseIsLive) => {
        time.tick(PROXY_CONTROL_HEARTBEAT_MS * 2);
        heldResponseSnapshot = { calls: heartbeatRpcCalls, failures: failures.length, leaseIsLive };
      },
      (reason) => rejectedReasons.push(reason),
    );
    const client: ControlClient = {
      ...endpoint.client,
      call(method, params, timeoutMs) {
        if (method === 'control.heartbeat.v1') heartbeatRpcCalls += 1;
        const response = endpoint.client.call(method, params, timeoutMs);
        if (method === 'control.heartbeat.v1') {
          void response.then(
            () => {
              acceptedResponses += 1;
            },
            () => undefined,
          );
        }
        return response;
      },
    };
    const clients = { proxy: client, guardian: passiveClient('guardian'), reaper: passiveClient('reaper') };
    const faultLatch = createProviderProxyAuthorityFaultLatch();
    faultLatch.onFault((fault) => failures.push(fault));
    endpoint.setElapsed(4_000);
    const heartbeats = startAll(sessions(clients, endpoint.opened), runtimeWithTime(time), faultLatch);

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await vi.waitFor(() => expect(heldResponseSnapshot).not.toBeNull());
    await vi.waitFor(() => expect(acceptedResponses).toBe(1));

    expect({
      heldResponseSnapshot,
      rejectedReasons,
      faults: failures.map((failure) =>
        failure.kind === 'operation-control-failed' ? failure.kind : `${failure.kind}:${failure.role}`,
      ),
    }).toEqual({
      heldResponseSnapshot: { calls: 1, failures: 0, leaseIsLive: true },
      rejectedReasons: [],
      faults: [],
    });

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await vi.waitFor(() => expect(heartbeatRpcCalls).toBe(2));
    expect(failures).toEqual([]);
    heartbeats.proxy.stop();
    heartbeats.guardian.stop();
    heartbeats.reaper.stop();
  });

  it('stops and reports one genuine endpoint challenge rejection', async () => {
    const time = new VirtualTime();
    let heartbeatRpcCalls = 0;
    let endpointRejections = 0;
    const failures: ProviderProxyAuthorityFault[] = [];
    const endpoint = await openLeaseEndpoint(undefined, () => {
      endpointRejections += 1;
    });
    const client: ControlClient = {
      ...endpoint.client,
      call(method, params, timeoutMs) {
        if (method === 'control.heartbeat.v1') heartbeatRpcCalls += 1;
        return endpoint.client.call(method, params, timeoutMs);
      },
    };
    const clients = { proxy: client, guardian: passiveClient('guardian'), reaper: passiveClient('reaper') };
    const faultLatch = createProviderProxyAuthorityFaultLatch();
    faultLatch.onFault((fault) => failures.push(fault));
    const heartbeatSessions = sessions(clients, endpoint.opened);
    const heartbeats = startAll(
      {
        ...heartbeatSessions,
        proxy: { ...heartbeatSessions.proxy, nextHeartbeatChallenge: 'wrong-challenge' },
      },
      runtimeWithTime(time),
      faultLatch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await vi.waitFor(() => expect(endpointRejections).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);

    expect({ endpointRejections, heartbeatRpcCalls, failures: failures.length }).toEqual({
      endpointRejections: 1,
      heartbeatRpcCalls: 1,
      failures: 1,
    });
    expect(failures[0]).toMatchObject({
      kind: 'heartbeat-failed',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      error: { code: 'control_call_failed', protocolCode: 'invalid_request' },
    });
    heartbeats.proxy.stop();
    heartbeats.guardian.stop();
    heartbeats.reaper.stop();
  });
});
