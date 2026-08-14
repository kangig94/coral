import type { ControlClient, ControlClientError } from '../../provider-proxy/control-client.js';
import type { ProxyControlProtocolErrorCode } from '../../provider-proxy/protocol.js';
import type { ProviderProxySetIdentity } from './provider-proxy-set-identity.js';

export type ProviderOperationSagaPhase =
  | 'prepare-pending'
  | 'guardian-activation-pending'
  | 'proxy-activation-pending'
  | 'prestart-cleanup-pending'
  | 'executing'
  | 'settlement-pending';

type ControlCallPolicyContext = Readonly<{
  method: string;
  phase: ProviderOperationSagaPhase;
  preEffectProtocolCodes: ReadonlySet<ProxyControlProtocolErrorCode>;
}>;

export type ObservationControlCallPolicy = ControlCallPolicyContext &
  Readonly<{ effect: 'observation'; indeterminate?: never }>;

export type RetrySafeControlCallPolicy = ControlCallPolicyContext &
  Readonly<{ effect: 'mutation'; indeterminate: 'retry-safe' }>;

export type ContainmentRequiredControlCallPolicy = ControlCallPolicyContext &
  Readonly<{ effect: 'mutation'; indeterminate: 'requires-containment' }>;

export type ControlCallPolicy =
  | ObservationControlCallPolicy
  | RetrySafeControlCallPolicy
  | ContainmentRequiredControlCallPolicy;

export type ProviderProxyRole = 'proxy' | 'guardian' | 'reaper';

export type ProviderProxyHeartbeatMethod = 'control.heartbeat.v1' | 'guardian.heartbeat.v1' | 'reaper.heartbeat.v1';

export type ProviderProxyAuthorityFault =
  | Readonly<{
      kind: 'operation-control-failed';
      policy: ContainmentRequiredControlCallPolicy;
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

/** A retry-safe operation failure delivered without consuming terminal fault state. */
export type ProviderProxyOperationIncident = Readonly<{
  kind: 'operation-control-failed';
  policy: RetrySafeControlCallPolicy;
  error: unknown;
}>;

/** The lifecycle decision retained at the provider-proxy-set action boundary. */
export type ProviderProxySetDecision =
  | Readonly<{
      action: 'preserve';
      reason: 'retry_safe_operation_control_failure';
      fault: 'operation-control-failed';
      policy: RetrySafeControlCallPolicy;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'stop-and-reap';
      reason: 'provider_authority_lost';
      fault: 'operation-control-failed';
      policy: ContainmentRequiredControlCallPolicy;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'stop-and-reap';
      reason: 'provider_authority_lost';
      fault: 'control-channel-fault';
      role: ProviderProxyRole;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'stop-and-reap';
      reason: 'provider_authority_lost';
      fault: 'heartbeat-failed';
      role: ProviderProxyRole;
      method: ProviderProxyHeartbeatMethod;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'drain';
      reason: 'graceful_idle' | 'excess_capacity' | 'unclaimed_discovery';
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'stop-and-reap';
      reason: 'graceful_idle' | 'excess_capacity' | 'unclaimed_discovery';
      liveClaims: 0;
      setIdentity: ProviderProxySetIdentity;
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
  reportIncident(incident: ProviderProxyOperationIncident): void;
  onIncident(listener: (incident: ProviderProxyOperationIncident) => void): () => void;
}

export function createProviderProxyAuthorityFaultLatch(): ProviderProxyAuthorityFaultLatch {
  let resolveFault!: (fault: ProviderProxyAuthorityFault) => void;
  let latchedFault: ProviderProxyAuthorityFault | null = null;
  const listeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  const incidentListeners = new Set<(incident: ProviderProxyOperationIncident) => void>();
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
    reportIncident(incident) {
      for (const listener of incidentListeners) listener(incident);
    },
    onIncident(listener) {
      incidentListeners.add(listener);
      return () => incidentListeners.delete(listener);
    },
  };
}
