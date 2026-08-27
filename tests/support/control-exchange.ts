import type { ControlClient } from '#src/provider-proxy/control-client.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';

/** Calls the real control-exchange boundary and requires its exact successful-result variant. */
export async function strictControlExchangeResult(
  control: Pick<ControlClient, 'exchange'>,
  method: string,
  params: unknown,
  timeoutMs = PROXY_CONTROL_RPC_TIMEOUT_MS,
): Promise<unknown> {
  const exchange = await control.exchange(method, params, timeoutMs);
  if (exchange.kind !== 'response') throw exchange.error;
  if (exchange.response.kind === 'result') return exchange.response.value;
  throw exchange.response.error;
}
