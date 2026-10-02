import { describe, expect, it } from 'vitest';
import { ControlClientError } from '#src/provider-proxy/control-client.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';

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
});
