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
  it('should replay every outstanding mutation and keep late subscribers attached for heartbeat faults', () => {
    const latch = createProviderProxyAuthorityFaultLatch();
    const operation = {
      jobId: 'job',
      operationId: 'operation',
      proxyInstanceId: 'proxy',
      buildSetId: 'build',
    };
    const first = {
      kind: 'operation-control-failed' as const,
      policy: {
        method: 'operation.cancel.v1',
        phase: 'prestart-cleanup-pending' as const,
        effect: 'mutation' as const,
        indeterminate: 'requires-containment' as const,
        preEffectProtocolCodes: new Set<never>(),
      },
      inspection: { operation, prepareAttemptKey: 'a'.repeat(64) },
      error: 'lost reply',
    };
    const second = { ...first, inspection: { operation, prepareAttemptKey: 'b'.repeat(64) } };
    latch.latch(first);
    latch.latch(second);
    const observed: unknown[] = [];
    latch.onFault((fault) => observed.push(fault));
    expect(observed).toEqual([first, second]);
    latch.acknowledgeOperationControlFault(first);
    expect(latch.hasOutstandingFaults()).toBe(true);
    const heartbeat = {
      kind: 'heartbeat-failed' as const,
      role: 'proxy' as const,
      method: 'control.heartbeat.v1' as const,
      terminalReason: 'teardown-latched' as const,
      error: 'teardown',
    };
    latch.latch(heartbeat);
    expect(observed).toEqual([first, second, heartbeat]);
    latch.acknowledgeOperationControlFault(second);
    expect(latch.hasOutstandingFaults()).toBe(true);
    const replayed: unknown[] = [];
    latch.onFault((fault) => replayed.push(fault));
    expect(replayed).toEqual([heartbeat]);
  });
});
