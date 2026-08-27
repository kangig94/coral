import { describe, expect, it } from 'vitest';

import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { heartbeatObservationFromExchange } from '#src/provider-proxy/heartbeat-observation.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyRole,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';

function faultSource() {
  const listeners = new Set<(error: ControlClientError) => void>();
  let faulted: ControlClientError | null = null;
  return {
    client: {
      onFault(listener: (error: ControlClientError) => void) {
        if (faulted !== null) {
          listener(faulted);
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    fault(error: ControlClientError) {
      faulted = error;
      for (const listener of listeners) listener(error);
    },
  };
}

describe('provider proxy authority fault latch', () => {
  it('replays an early heartbeat incident and its accepted echo to a late subscriber', () => {
    const latch = createProviderProxyAuthorityFaultLatch();
    const observed: unknown[] = [];
    const timeout = new ControlClientError('control_call_failed', 'timed out', 'timeout');
    const unanswered = {
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: heartbeatObservationFromExchange({ kind: 'no-response', cause: 'timeout', error: timeout }),
      schedulerLatenessMs: 0,
    } as const;
    const accepted = {
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: heartbeatObservationFromExchange({
        kind: 'response',
        response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'next-challenge' } },
      }),
      schedulerLatenessMs: 0,
    } as const;
    latch.reportIncident(unanswered);
    latch.reportIncident(accepted);

    latch.onIncident((observation) => observed.push(observation));

    expect(observed).toEqual([unanswered, accepted]);
  });

  it('replays only the latest of two pending incidents for the same role and method', () => {
    const latch = createProviderProxyAuthorityFaultLatch();
    const timeout = new ControlClientError('control_call_failed', 'timed out', 'timeout');
    latch.reportIncident({
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: heartbeatObservationFromExchange({ kind: 'no-response', cause: 'timeout', error: timeout }),
      schedulerLatenessMs: 0,
    });
    const refusal = new ControlClientError('control_call_failed', 'answer could not be decoded', 'remote-response', {
      kind: 'json-rpc-error',
      jsonRpcCode: -32_600,
      protocolCode: 'invalid_request',
      admissionReason: null,
      heartbeatRefusal: null,
    });
    if (refusal.remoteFailure === null) throw new Error('test heartbeat refusal lacks remote failure');
    const unusable = {
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: heartbeatObservationFromExchange({
        kind: 'response',
        response: { kind: 'refusal', failure: refusal.remoteFailure, error: refusal },
      }),
      schedulerLatenessMs: 0,
    } as const;
    latch.reportIncident(unusable);

    const observed: unknown[] = [];
    latch.onIncident((observation) => observed.push(observation));

    expect(observed).toEqual([unusable]);
  });

  it.each(['proxy', 'guardian', 'reaper'] as const)('latches a %s channel fault with its exact role', (role) => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch();
    latch.observeControlClient('proxy', sources.proxy.client);
    latch.observeControlClient('guardian', sources.guardian.client);
    latch.observeControlClient('reaper', sources.reaper.client);
    let observed: { role: ProviderProxyRole; code: string } | null = null;
    latch.onFault((fault) => {
      if (fault.kind === 'control-channel-fault') {
        observed = { role: fault.role, code: fault.error.code };
      }
    });

    sources[role].fault(new ControlClientError('control_client_closed', `${role} channel closed`, 'closed'));

    expect(observed).toEqual({ role, code: 'control_client_closed' });
  });

  it('retains the first fault and invokes late subscribers inline', () => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch();
    latch.observeControlClient('proxy', sources.proxy.client);
    latch.observeControlClient('guardian', sources.guardian.client);
    latch.observeControlClient('reaper', sources.reaper.client);
    const first = new ControlClientError('control_client_closed', 'guardian channel closed', 'closed');
    sources.guardian.fault(first);
    sources.proxy.fault(new ControlClientError('control_client_closed', 'proxy channel closed', 'closed'));
    let observed: unknown = null;

    latch.onFault((fault) => {
      observed = fault;
    });

    expect(observed).toEqual({ kind: 'control-channel-fault', role: 'guardian', error: first });
  });

  it('observes a client fault that was stored before enrollment inline', () => {
    const source = faultSource();
    const error = new ControlClientError('control_client_closed', 'reaper channel already closed', 'closed');
    source.fault(error);
    const latch = createProviderProxyAuthorityFaultLatch();
    let observed: unknown = null;
    latch.onFault((fault) => {
      observed = fault;
    });

    latch.observeControlClient('reaper', source.client);

    expect(observed).toEqual({ kind: 'control-channel-fault', role: 'reaper', error });
  });
});
