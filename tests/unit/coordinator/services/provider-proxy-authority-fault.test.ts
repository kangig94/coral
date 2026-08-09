import { describe, expect, it } from 'vitest';

import { ControlClientError } from '#src/provider-proxy/control-client.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyRole,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';

function faultSource() {
  const listeners = new Set<(error: ControlClientError) => void>();
  return {
    client: {
      onFault(listener: (error: ControlClientError) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    fault(error: ControlClientError) {
      for (const listener of listeners) listener(error);
    },
  };
}

describe('provider proxy authority fault latch', () => {
  it.each(['proxy', 'guardian', 'reaper'] as const)('latches a %s channel fault with its exact role', (role) => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch({
      proxy: sources.proxy.client,
      guardian: sources.guardian.client,
      reaper: sources.reaper.client,
    });
    let observed: { role: ProviderProxyRole; code: string } | null = null;
    latch.onFault((fault) => {
      if (fault.kind === 'control-channel-fault') {
        observed = { role: fault.role, code: fault.error.code };
      }
    });

    sources[role].fault(new ControlClientError('control_client_closed', `${role} channel closed`));

    expect(observed).toEqual({ role, code: 'control_client_closed' });
  });

  it('retains the first fault and invokes late subscribers inline', () => {
    const sources = {
      proxy: faultSource(),
      guardian: faultSource(),
      reaper: faultSource(),
    };
    const latch = createProviderProxyAuthorityFaultLatch({
      proxy: sources.proxy.client,
      guardian: sources.guardian.client,
      reaper: sources.reaper.client,
    });
    const first = new ControlClientError('control_client_closed', 'guardian channel closed');
    sources.guardian.fault(first);
    sources.proxy.fault(new ControlClientError('control_client_closed', 'proxy channel closed'));
    let observed: unknown = null;

    latch.onFault((fault) => {
      observed = fault;
    });

    expect(observed).toEqual({ kind: 'control-channel-fault', role: 'guardian', error: first });
  });
});
