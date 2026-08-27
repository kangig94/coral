import { describe, expect, it, vi } from 'vitest';

import {
  createProviderProxyAuthorityHeartbeatAssembly,
  heartbeatOnce,
  type ProviderProxyHeartbeatSession,
  type ProviderProxyRoleHeartbeats,
} from '#src/coordinator/live/provider-proxy/heartbeat.js';
import type {
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyHeartbeatObservation,
  ProviderProxyRole,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { ControlClientError, type ControlClient, type ControlExchange } from '#src/provider-proxy/control-client.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '#src/provider-proxy/orphan-deadline.js';
import type { Runtime } from '#src/runtime/ports.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

type RecordedCall = Readonly<{ controlEpoch: number; heartbeatChallenge: string }>;

/** Answers each `exchange` with the next scripted transport outcome. A challenge string is shorthand for an
 *  accepted result. The last entry repeats once exhausted, so a test can assert on ticks past its
 *  scripted list without needing one entry per tick. */
function scriptedClient(replies: readonly (string | ControlExchange)[]): {
  client: ControlClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const client: ControlClient = {
    exchange: (_method, params): Promise<ControlExchange> => {
      calls.push(params as RecordedCall);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return Promise.resolve(
        typeof reply === 'string'
          ? {
              kind: 'response',
              response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: reply } },
            }
          : reply,
      );
    },
    call: () => Promise.reject(new Error('unexpected compatibility call')),
    faulted: new Promise<never>(() => undefined),
    onFault: () => () => undefined,
    close: () => {},
  };
  return { client, calls };
}

function refusal(error: ControlClientError): ControlExchange {
  if (error.remoteFailure === null) throw new Error('test refusal requires a remote failure');
  return { kind: 'response', response: { kind: 'refusal', failure: error.remoteFailure, error } };
}

function noResponse(error: ControlClientError): ControlExchange {
  return { kind: 'no-response', cause: 'timeout', error };
}

function runtimeWithTime(time: VirtualTime): Runtime {
  return { time } as unknown as Runtime;
}

function sessions(clients: { proxy: ControlClient; guardian: ControlClient; reaper: ControlClient }) {
  return {
    proxy: {
      client: clients.proxy,
      controlEpoch: 7,
      nextHeartbeatChallenge: 'proxy-challenge-0',
      instanceId: 'proxy-1',
    },
    guardian: {
      client: clients.guardian,
      controlEpoch: 8,
      nextHeartbeatChallenge: 'guardian-challenge-0',
      instanceId: 'guardian-1',
    },
    reaper: {
      client: clients.reaper,
      controlEpoch: 9,
      nextHeartbeatChallenge: 'reaper-challenge-0',
      instanceId: 'reaper-1',
    },
  } satisfies Record<ProviderProxyRole, ProviderProxyHeartbeatSession>;
}

function startAll(
  heartbeatSessions: ReturnType<typeof sessions>,
  runtime: Runtime,
  faults: ProviderProxyAuthorityFaultLatch,
): ProviderProxyRoleHeartbeats {
  const assembly = createProviderProxyAuthorityHeartbeatAssembly(runtime, faults);
  assembly.startRole('proxy', heartbeatSessions.proxy);
  assembly.startRole('guardian', heartbeatSessions.guardian);
  assembly.startRole('reaper', heartbeatSessions.reaper);
  return assembly.complete();
}

function recordingFaultLatch(): {
  latch: ProviderProxyAuthorityFaultLatch;
  faults: ProviderProxyAuthorityFault[];
  incidents: ProviderProxyHeartbeatObservation[];
  accepted: ProviderProxyHeartbeatObservation[];
} {
  const faults: ProviderProxyAuthorityFault[] = [];
  const incidents: ProviderProxyHeartbeatObservation[] = [];
  const accepted: ProviderProxyHeartbeatObservation[] = [];
  return {
    latch: {
      faulted: new Promise<never>(() => undefined),
      observeControlClient: () => undefined,
      latch: (fault) => faults.push(fault),
      onFault: () => () => undefined,
      reportIncident: (observation) => {
        if (observation.kind !== 'heartbeat-observation') return;
        if (observation.observation.kind === 'reply' && observation.observation.reply.kind === 'accepted') {
          accepted.push(observation);
        } else {
          incidents.push(observation);
        }
      },
      onIncident: () => () => undefined,
    },
    faults,
    incidents,
    accepted,
  };
}

function stopAll(heartbeats: ProviderProxyRoleHeartbeats): void {
  heartbeats.proxy.stop();
  heartbeats.guardian.stop();
  heartbeats.reaper.stop();
}

describe('provider proxy authority heartbeats', () => {
  it('rejects a duplicate role and refuses to complete a partial assembly', () => {
    const time = new VirtualTime();
    const proxy = scriptedClient(['proxy-challenge-1']);
    const session = sessions({ proxy: proxy.client, guardian: proxy.client, reaper: proxy.client }).proxy;
    const assembly = createProviderProxyAuthorityHeartbeatAssembly(runtimeWithTime(time), recordingFaultLatch().latch);

    assembly.startRole('proxy', session);

    expect(() => assembly.startRole('proxy', session)).toThrow('provider_proxy_heartbeat_role_already_started:proxy');
    expect(() => assembly.complete()).toThrow('provider_proxy_heartbeat_roles_incomplete');
    assembly.stop();
  });

  it('stops every role enrolled in a partial assembly', () => {
    const time = new VirtualTime();
    const clearIntervalSpy = vi.spyOn(time, 'clearInterval');
    const proxy = scriptedClient(['proxy-challenge-1']);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const heartbeatSessions = sessions({ proxy: proxy.client, guardian: guardian.client, reaper: proxy.client });
    const assembly = createProviderProxyAuthorityHeartbeatAssembly(runtimeWithTime(time), recordingFaultLatch().latch);
    assembly.startRole('proxy', heartbeatSessions.proxy);
    assembly.startRole('guardian', heartbeatSessions.guardian);

    assembly.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid heartbeat before the untyped control client can write it', async () => {
    const exchange = vi.fn(
      async (): Promise<ControlExchange> => ({
        kind: 'response',
        response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'challenge-1' } },
      }),
    );
    const client: ControlClient = {
      exchange,
      call: () => Promise.reject(new Error('unexpected compatibility call')),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };

    await expect(heartbeatOnce(client, 'control.heartbeat.v1', -1, 'challenge-0')).rejects.toThrow();

    expect(exchange).not.toHaveBeenCalled();
  });

  it('echoes the current challenge on every tick and carries the reply into the next one', async () => {
    const time = new VirtualTime();
    const proxy = scriptedClient(['proxy-challenge-1', 'proxy-challenge-2']);
    const guardian = scriptedClient(['guardian-challenge-1', 'guardian-challenge-2']);
    const reaper = scriptedClient(['reaper-challenge-1', 'reaper-challenge-2']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(proxy.calls).toEqual([
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' },
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-1' },
    ]);
    expect(faults.faults).toEqual([]);
    stopAll(heartbeats);
  });

  it('skips interval ticks while an accepted heartbeat response is pending', async () => {
    const time = new VirtualTime();
    let resolveFirst!: (value: ControlExchange) => void;
    const first = new Promise<ControlExchange>((resolve) => {
      resolveFirst = resolve;
    });
    const exchange = vi
      .fn<ControlClient['exchange']>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({
        kind: 'response',
        response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'challenge-2' } },
      });
    const client = {
      exchange,
      call: () => Promise.reject(new Error('unexpected compatibility call')),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    } satisfies ControlClient;
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
    await flushMicrotasks();

    expect(exchange).toHaveBeenCalledTimes(1);
    expect(faults.faults).toEqual([]);

    resolveFirst({
      kind: 'response',
      response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'challenge-1' } },
    });
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(exchange).toHaveBeenCalledTimes(2);
    expect(exchange.mock.calls[1]?.[1]).toEqual({ controlEpoch: 7, heartbeatChallenge: 'challenge-1' });
    stopAll(heartbeats);
  });

  it.each([
    ['proxy', 'control.heartbeat.v1', 7],
    ['guardian', 'guardian.heartbeat.v1', 8],
    ['reaper', 'reaper.heartbeat.v1', 9],
  ] as const)(
    'reports an unclassified %s heartbeat refusal and retries the same challenge',
    async (role, method, controlEpoch) => {
      const time = new VirtualTime();
      const error = new ControlClientError('control_call_failed', `${role} heartbeat refused`, 'remote-response', {
        kind: 'json-rpc-error',
        jsonRpcCode: -32_600,
        protocolCode: 'invalid_request',
        admissionReason: null,
        heartbeatRefusal: null,
      });
      const sources: Record<ProviderProxyRole, ReturnType<typeof scriptedClient>> = {
        proxy: scriptedClient(role === 'proxy' ? [refusal(error)] : ['proxy-challenge-1']),
        guardian: scriptedClient(role === 'guardian' ? [refusal(error)] : ['guardian-challenge-1']),
        reaper: scriptedClient(role === 'reaper' ? [refusal(error)] : ['reaper-challenge-1']),
      };
      const faults = recordingFaultLatch();
      const heartbeats = startAll(
        sessions({
          proxy: sources.proxy.client,
          guardian: sources.guardian.client,
          reaper: sources.reaper.client,
        }),
        runtimeWithTime(time),
        faults.latch,
      );

      time.tick(PROXY_CONTROL_HEARTBEAT_MS);
      await flushMicrotasks();

      time.tick(PROXY_CONTROL_HEARTBEAT_MS);
      await flushMicrotasks();

      expect(sources[role].calls).toEqual([
        { controlEpoch, heartbeatChallenge: `${role}-challenge-0` },
        { controlEpoch, heartbeatChallenge: `${role}-challenge-0` },
      ]);
      expect(faults.incidents).toEqual([
        {
          kind: 'heartbeat-observation',
          role,
          method,
          observation: { kind: 'reply', reply: { kind: 'unusable', error } },
          schedulerLatenessMs: 0,
        },
        {
          kind: 'heartbeat-observation',
          role,
          method,
          observation: { kind: 'reply', reply: { kind: 'unusable', error } },
          schedulerLatenessMs: 0,
        },
      ]);
      expect(faults.faults).toEqual([]);
      stopAll(heartbeats);
    },
  );

  it('reports method-not-found as protocol incompatibility and stops retrying the heartbeat', async () => {
    const time = new VirtualTime();
    const methodNotFound = new ControlClientError('control_call_failed', 'method not found', 'remote-response', {
      kind: 'json-rpc-error',
      jsonRpcCode: -32_601,
      protocolCode: 'method_not_found',
      admissionReason: null,
      heartbeatRefusal: null,
    });
    const proxy = scriptedClient([refusal(methodNotFound)]);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
    await flushMicrotasks();

    expect(proxy.calls).toEqual([{ controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' }]);
    expect(faults.incidents).toEqual([
      {
        kind: 'heartbeat-observation',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        observation: { kind: 'reply', reply: { kind: 'method-not-found', error: methodNotFound } },
        schedulerLatenessMs: 0,
      },
    ]);
    expect(faults.faults).toEqual([]);
    stopAll(heartbeats);
  });

  it('reports an unanswered echo as an incident and retries the same challenge on the next tick', async () => {
    const time = new VirtualTime();
    const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
    const proxy = scriptedClient([noResponse(timeout), 'proxy-challenge-1']);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(proxy.calls).toEqual([
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' },
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' },
    ]);
    expect(faults.incidents).toEqual([
      {
        kind: 'heartbeat-observation',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        observation: { kind: 'no-response-before-deadline', error: timeout },
        schedulerLatenessMs: 0,
      },
    ]);
    expect(faults.accepted).toContainEqual({
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: { kind: 'reply', reply: { kind: 'accepted', nextChallenge: 'proxy-challenge-1' } },
      schedulerLatenessMs: 0,
    });
    expect(faults.faults).toEqual([]);
    stopAll(heartbeats);
  });

  it('attaches observed scheduler lateness to the unanswered role and method', async () => {
    const time = new VirtualTime();
    const actualMonotonicNow = time.monotonicNow.bind(time);
    let schedulerDelayMs = 0;
    vi.spyOn(time, 'monotonicNow').mockImplementation(() => actualMonotonicNow() + BigInt(schedulerDelayMs));
    const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
    const proxy = scriptedClient([noResponse(timeout)]);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    schedulerDelayMs = 2_000;
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(faults.incidents).toEqual([
      {
        kind: 'heartbeat-observation',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        observation: { kind: 'no-response-before-deadline', error: timeout },
        schedulerLatenessMs: 2_000,
      },
    ]);
    stopAll(heartbeats);
  });

  it('resynchronizes after a lost acknowledgement makes the retained challenge mismatch', async () => {
    const time = new VirtualTime();
    const timeout = new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
    const mismatch = new ControlClientError('control_call_failed', 'challenge mismatch', 'remote-response', {
      kind: 'json-rpc-error',
      jsonRpcCode: -32_600,
      protocolCode: 'invalid_request',
      admissionReason: null,
      heartbeatRefusal: { reason: 'challenge-mismatch', nextHeartbeatChallenge: 'proxy-challenge-fresh' },
    });
    const proxy = scriptedClient([noResponse(timeout), refusal(mismatch), 'proxy-challenge-2']);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();
    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(proxy.calls).toEqual([
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' },
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-0' },
      { controlEpoch: 7, heartbeatChallenge: 'proxy-challenge-fresh' },
    ]);
    expect(faults.incidents).toEqual([
      expect.objectContaining({
        kind: 'heartbeat-observation',
        observation: { kind: 'no-response-before-deadline', error: timeout },
      }),
      expect.objectContaining({
        kind: 'heartbeat-observation',
        observation: {
          kind: 'reply',
          reply: { kind: 'challenge-mismatch', nextChallenge: 'proxy-challenge-fresh' },
        },
      }),
    ]);
    expect(faults.faults).toEqual([]);
    stopAll(heartbeats);
  });

  it('latches teardown-latched as a terminal heartbeat fault', async () => {
    const time = new VirtualTime();
    const teardownRefusal = new ControlClientError('control_call_failed', 'teardown latched', 'remote-response', {
      kind: 'json-rpc-error',
      jsonRpcCode: -32_600,
      protocolCode: 'invalid_request',
      admissionReason: null,
      heartbeatRefusal: { reason: 'teardown-latched', nextHeartbeatChallenge: null },
    });
    const proxy = scriptedClient([refusal(teardownRefusal)]);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(faults.faults).toEqual([
      {
        kind: 'heartbeat-failed',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        terminalReason: 'teardown-latched',
        error: teardownRefusal,
      },
    ]);
    stopAll(heartbeats);
  });

  it('latches a non-ControlClientError as a local-failure terminal, not an indeterminate hold', async () => {
    const time = new VirtualTime();
    // Not a `ControlClientError` at all — the raw `ProxyControlProtocolError`/`ZodError` shape this process's
    // own encode/decode path can raise, reaching the loop unwrapped.
    const localBug = new Error('cannot encode heartbeat');
    const proxy = scriptedClient([{ kind: 'not-sent', cause: 'encode-failed', error: localBug }]);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(faults.faults).toEqual([
      {
        kind: 'heartbeat-failed',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        terminalReason: 'local-failure',
        error: localBug,
      },
    ]);
    // The authority channel preserves the owner-classified observation, while the terminal path remains local.
    expect(faults.incidents).toEqual([
      {
        kind: 'heartbeat-observation',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        observation: { kind: 'locally-unsent', stage: 'request-encode', error: localBug },
        schedulerLatenessMs: 0,
      },
    ]);

    // The loop stopped rather than retrying a call that is guaranteed to fail identically again.
    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
    await flushMicrotasks();
    expect(proxy.calls).toHaveLength(1);
    stopAll(heartbeats);
  });

  it('reports an undecodable heartbeat reply as an unclassified incident, never a local failure', async () => {
    // The peer answered, but the result fails the heartbeat owner's strict schema. That is a fact about the
    // reply, not about whether this process could ask, so it must not latch a local-failure terminal.
    const time = new VirtualTime();
    const proxyClient: ControlClient = {
      exchange: async () => ({ kind: 'response', response: { kind: 'result', value: { unexpected: 'shape' } } }),
      call: () => Promise.reject(new Error('unexpected compatibility call')),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => {},
    };
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const faults = recordingFaultLatch();
    const heartbeats = startAll(
      sessions({ proxy: proxyClient, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      faults.latch,
    );

    time.tick(PROXY_CONTROL_HEARTBEAT_MS);
    await flushMicrotasks();

    expect(faults.incidents).toEqual([
      expect.objectContaining({
        kind: 'heartbeat-observation',
        role: 'proxy',
        observation: { kind: 'reply', reply: expect.objectContaining({ kind: 'unusable' }) },
      }),
    ]);
    expect(faults.faults).toEqual([]);
    stopAll(heartbeats);
  });

  it('stop() clears the interval on the runtime, not just its own internal flag', async () => {
    const time = new VirtualTime();
    // A spy on `clearInterval` itself, not just an absence of later calls: the loop's own `stopped` flag
    // already short-circuits `tick()` on its own, so asserting no further calls would pass even if `stop()`
    // forgot to release the runtime's timer handle.
    const clearIntervalSpy = vi.spyOn(time, 'clearInterval');
    const proxy = scriptedClient(['proxy-challenge-1']);
    const guardian = scriptedClient(['guardian-challenge-1']);
    const reaper = scriptedClient(['reaper-challenge-1']);
    const heartbeats = startAll(
      sessions({ proxy: proxy.client, guardian: guardian.client, reaper: reaper.client }),
      runtimeWithTime(time),
      recordingFaultLatch().latch,
    );

    heartbeats.proxy.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
    await flushMicrotasks();

    expect(proxy.calls).toEqual([]);
    heartbeats.guardian.stop();
    heartbeats.reaper.stop();
  });
});
