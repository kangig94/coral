import type { ControlClient, ControlClientError } from '../../provider-proxy/control-client.js';
import type { ProxyControlProtocolErrorCode } from '../../provider-proxy/protocol.js';

export type ProviderOperationSagaPhase =
  | 'prepare-pending'
  | 'guardian-activation-pending'
  | 'proxy-activation-pending'
  | 'prestart-cleanup-pending'
  | 'executing'
  | 'settlement-pending';

export type ControlCallPolicy = Readonly<{
  method: string;
  phase: ProviderOperationSagaPhase;
  effect: 'observation' | 'mutation';
  preEffectProtocolCodes: ReadonlySet<ProxyControlProtocolErrorCode>;
}>;

export type ProviderProxyRole = 'proxy' | 'guardian' | 'reaper';

export type ProviderProxyHeartbeatMethod = 'control.heartbeat.v1' | 'guardian.heartbeat.v1' | 'reaper.heartbeat.v1';

export type ProviderProxyAuthorityFault =
  | Readonly<{
      kind: 'operation-control-failed';
      policy: ControlCallPolicy;
      error: unknown;
    }>
  | Readonly<{
      kind: 'control-channel-fault';
      role: ProviderProxyRole;
      error: ControlClientError;
    }>
  | Readonly<{
      kind: 'heartbeat-failed';
      role: ProviderProxyRole;
      method: ProviderProxyHeartbeatMethod;
      error: unknown;
    }>;

export type ProviderProxyRoleClients<TClient> = Readonly<{
  proxy: TClient;
  guardian: TClient;
  reaper: TClient;
}>;

export interface ProviderProxyAuthorityFaultLatch {
  readonly faulted: Promise<ProviderProxyAuthorityFault>;
  observeControlClient(role: ProviderProxyRole, client: Pick<ControlClient, 'onFault'>): void;
  latch(fault: ProviderProxyAuthorityFault): void;
  onFault(listener: (fault: ProviderProxyAuthorityFault) => void): () => void;
}

export function createProviderProxyAuthorityFaultLatch(): ProviderProxyAuthorityFaultLatch {
  let resolveFault!: (fault: ProviderProxyAuthorityFault) => void;
  let latchedFault: ProviderProxyAuthorityFault | null = null;
  const listeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  const faulted = new Promise<ProviderProxyAuthorityFault>((resolve) => {
    resolveFault = resolve;
  });
  const latch = (fault: ProviderProxyAuthorityFault): void => {
    if (latchedFault !== null) return;
    latchedFault = fault;
    resolveFault(fault);
    for (const listener of listeners) listener(fault);
  };
  return {
    faulted,
    observeControlClient(role, client) {
      client.onFault((error) => latch({ kind: 'control-channel-fault', role, error }));
    },
    latch,
    onFault(listener) {
      if (latchedFault !== null) {
        listener(latchedFault);
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
