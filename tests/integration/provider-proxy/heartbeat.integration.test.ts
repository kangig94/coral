import { afterEach, expect, it, vi } from 'vitest';

import { createProviderProxyAuthorityHeartbeatAssembly } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import { PROXY_CONTROL_HEARTBEAT_MS } from '#src/provider-proxy/orphan-deadline.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createDeferred } from '#tools/testing/deferred.js';

const assemblies: ReturnType<typeof createProviderProxyAuthorityHeartbeatAssembly>[] = [];
afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.stop();
});

function startHeartbeat(exchange: ControlClient['exchange']) {
  const runtime = new SimulationRuntime();
  const time = runtime.time;
  const faults = createProviderProxyAuthorityFaultLatch();
  const client: ControlClient = {
    exchange,
    faulted: new Promise<never>(() => {}),
    onFault: () => () => {},
    close: () => {},
  };
  const assembly = createProviderProxyAuthorityHeartbeatAssembly(runtime, faults);
  assemblies.push(assembly);
  assembly.startRole('proxy', {
    client,
    controlEpoch: 1,
    nextHeartbeatChallenge: 'challenge-1',
    instanceId: 'proxy-1',
  });
  return { time, faults };
}

it('keeps one heartbeat outstanding across multiple scheduler intervals', async () => {
  const response = createDeferred<ControlExchange>();
  const exchange = vi.fn<ControlClient['exchange']>(() => response.promise);
  const { time } = startHeartbeat(exchange);
  time.tick(PROXY_CONTROL_HEARTBEAT_MS * 3);
  expect(exchange).toHaveBeenCalledOnce();

  response.resolve(
    controlExchangeForTest({
      kind: 'response',
      response: {
        kind: 'result',
        value: { state: 'active', nextHeartbeatChallenge: 'challenge-2' },
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  time.tick(PROXY_CONTROL_HEARTBEAT_MS);
  expect(exchange).toHaveBeenCalledTimes(2);
  expect(exchange.mock.calls[1][1]).toEqual({ controlEpoch: 1, heartbeatChallenge: 'challenge-2' });
});

it('uses the replacement challenge after a mismatch without losing authority', async () => {
  const exchange = vi
    .fn<ControlClient['exchange']>()
    .mockResolvedValueOnce(
      controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'refusal',
          failure: {
            kind: 'json-rpc-error',
            jsonRpcCode: -32600,
            protocolCode: 'invalid_request',
            admissionReason: null,
            heartbeatRefusal: { reason: 'challenge-mismatch', nextHeartbeatChallenge: 'challenge-2' },
          },
          error: new ControlClientError('control_call_failed', 'challenge mismatch', 'remote-response', {
            kind: 'json-rpc-error',
            jsonRpcCode: -32600,
            protocolCode: 'invalid_request',
            admissionReason: null,
            heartbeatRefusal: { reason: 'challenge-mismatch', nextHeartbeatChallenge: 'challenge-2' },
          }),
        },
      }),
    )
    .mockResolvedValue(
      controlExchangeForTest({
        kind: 'response',
        response: {
          kind: 'result',
          value: { state: 'active', nextHeartbeatChallenge: 'challenge-3' },
        },
      }),
    );
  const { time, faults } = startHeartbeat(exchange);
  const observedFaults: unknown[] = [];
  faults.onFault((fault) => observedFaults.push(fault));
  time.tick(PROXY_CONTROL_HEARTBEAT_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  time.tick(PROXY_CONTROL_HEARTBEAT_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(exchange.mock.calls.map((call) => call[1])).toEqual([
    { controlEpoch: 1, heartbeatChallenge: 'challenge-1' },
    { controlEpoch: 1, heartbeatChallenge: 'challenge-2' },
  ]);
  expect(observedFaults).toEqual([]);
});
