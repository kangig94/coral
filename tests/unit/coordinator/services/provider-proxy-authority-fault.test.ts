import { describe, expect, it } from 'vitest';

import { ControlClientError, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
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
      observation: heartbeatObservationFromExchange(
        controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error: timeout }),
      ),
      schedulerLatenessMs: 0,
    } as const;
    const accepted = {
      kind: 'heartbeat-observation',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      observation: heartbeatObservationFromExchange(
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'active', nextHeartbeatChallenge: 'next-challenge' } },
        }),
      ),
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
      observation: heartbeatObservationFromExchange(
        controlExchangeForTest({ kind: 'no-response', cause: 'timeout', error: timeout }),
      ),
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
      observation: heartbeatObservationFromExchange(
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'refusal', failure: refusal.remoteFailure, error: refusal },
        }),
      ),
      schedulerLatenessMs: 0,
    } as const;
    latch.reportIncident(unusable);

    const observed: unknown[] = [];
    latch.onIncident((observation) => observed.push(observation));

    expect(observed).toEqual([unusable]);
  });

  it.each(['proxy', 'guardian', 'reaper'] as const)('reports a %s channel close with its exact role', (role) => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch();
    latch.observeControlClient('proxy', sources.proxy.client);
    latch.observeControlClient('guardian', sources.guardian.client);
    latch.observeControlClient('reaper', sources.reaper.client);
    let observed: { role: ProviderProxyRole; cause: string; code: string } | null = null;
    latch.onIncident((incident) => {
      if (incident.kind === 'control-channel-fault') {
        observed = { role: incident.role, cause: incident.cause, code: incident.error.code };
      }
    });

    sources[role].fault(new ControlClientError('control_client_closed', `${role} channel closed`, 'closed'));

    expect(observed).toEqual({ role, cause: 'closed', code: 'control_client_closed' });
  });

  it('keeps separate channel observations visible without latching either as terminal', () => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch();
    latch.observeControlClient('proxy', sources.proxy.client);
    latch.observeControlClient('guardian', sources.guardian.client);
    latch.observeControlClient('reaper', sources.reaper.client);
    const observedIncidents: unknown[] = [];
    const observedFaults: unknown[] = [];
    latch.onIncident((incident) => observedIncidents.push(incident));
    latch.onFault((fault) => observedFaults.push(fault));
    const guardian = new ControlClientError('control_client_closed', 'guardian channel closed', 'closed');
    const proxy = new ControlClientError('control_client_closed', 'proxy channel closed', 'closed');
    sources.guardian.fault(guardian);
    sources.proxy.fault(proxy);

    expect(observedIncidents).toEqual([
      { kind: 'control-channel-fault', role: 'guardian', cause: 'closed', error: guardian },
      { kind: 'control-channel-fault', role: 'proxy', cause: 'closed', error: proxy },
    ]);
    expect(observedFaults).toEqual([]);
  });

  it('observes a client fault that was stored before enrollment inline', () => {
    const source = faultSource();
    const error = new ControlClientError('control_client_closed', 'reaper channel already closed', 'closed');
    source.fault(error);
    const latch = createProviderProxyAuthorityFaultLatch();
    let observed: unknown = null;
    latch.onIncident((incident) => {
      observed = incident;
    });

    latch.observeControlClient('reaper', source.client);

    expect(observed).toEqual({ kind: 'control-channel-fault', role: 'reaper', cause: 'closed', error });
  });

  it('preserves an unattributable invalid frame as a different channel cause', () => {
    const source = faultSource();
    const error = new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
      kind: 'invalid-frame',
    });
    const latch = createProviderProxyAuthorityFaultLatch();
    const observed: unknown[] = [];
    latch.onIncident((incident) => observed.push(incident));
    latch.observeControlClient('proxy', source.client);

    source.fault(error);

    expect(observed).toEqual([
      { kind: 'control-channel-fault', role: 'proxy', cause: 'invalid-unattributable-frame', error },
    ]);
  });
});
