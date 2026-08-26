import { describe, expect, it } from 'vitest';

import { ControlClientError } from '#src/provider-proxy/control-client.js';
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
    latch.reportIncident({
      kind: 'heartbeat-indeterminate',
      role: 'proxy',
      method: 'control.heartbeat.v1',
      incidentReason: 'unanswered',
      error: 'timed out',
    });
    latch.reportIncident({ kind: 'heartbeat-accepted', role: 'proxy', method: 'control.heartbeat.v1' });

    latch.onIncident((observation) => observed.push(observation));

    expect(observed).toEqual([
      {
        kind: 'heartbeat-indeterminate',
        role: 'proxy',
        method: 'control.heartbeat.v1',
        incidentReason: 'unanswered',
        error: 'timed out',
      },
      { kind: 'heartbeat-accepted', role: 'proxy', method: 'control.heartbeat.v1' },
    ]);
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
