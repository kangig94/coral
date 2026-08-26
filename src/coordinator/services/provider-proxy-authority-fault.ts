import type { ControlClient, ControlClientError } from '../../provider-proxy/control-client.js';
import type { ProxyControlProtocolErrorCode } from '../../provider-proxy/protocol.js';

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
/** `teardown-latched` is the endpoint's own decisive refusal. `local-failure` is this process's own — it
 *  could not construct or decode a heartbeat call at all, so nothing about the peer was ever in question. */
export type ProviderProxyHeartbeatTerminalReason = 'teardown-latched' | 'local-failure';
export type ProviderProxyHeartbeatIncidentReason = 'unanswered' | 'challenge-resynchronized' | 'unclassified';

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
      terminalReason: ProviderProxyHeartbeatTerminalReason;
      error: unknown;
    }>;

export type ProviderProxyAuthorityIncident =
  | Readonly<{
      kind: 'operation-control-failed';
      policy: RetrySafeControlCallPolicy;
      error: unknown;
    }>
  | Readonly<{
      kind: 'heartbeat-indeterminate';
      role: ProviderProxyRole;
      method: ProviderProxyHeartbeatMethod;
      incidentReason: ProviderProxyHeartbeatIncidentReason;
      error: unknown;
    }>;

export type ProviderProxyHeartbeatAccepted = Readonly<{
  kind: 'heartbeat-accepted';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
}>;

/** Nothing delivered on this channel may consume terminal fault state. */
export type ProviderProxyAuthorityObservation = ProviderProxyAuthorityIncident | ProviderProxyHeartbeatAccepted;

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
  reportIncident(observation: ProviderProxyAuthorityObservation): void;
  onIncident(listener: (observation: ProviderProxyAuthorityObservation) => void): () => void;
}

type PendingIncident = {
  incident: ProviderProxyAuthorityIncident;
  accepted: ProviderProxyHeartbeatAccepted | null;
};

const MAX_PENDING_INCIDENTS = 32;

function incidentKey(incident: ProviderProxyAuthorityIncident): string {
  return incident.kind === 'heartbeat-indeterminate'
    ? JSON.stringify([incident.role, incident.method])
    : JSON.stringify([incident.kind, incident.policy.method]);
}

function acceptedHeartbeatKey(accepted: ProviderProxyHeartbeatAccepted): string {
  return JSON.stringify([accepted.role, accepted.method]);
}

export function createProviderProxyAuthorityFaultLatch(): ProviderProxyAuthorityFaultLatch {
  let resolveFault!: (fault: ProviderProxyAuthorityFault) => void;
  let latchedFault: ProviderProxyAuthorityFault | null = null;
  const listeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  const incidentListeners = new Set<(observation: ProviderProxyAuthorityObservation) => void>();
  const pendingIncidents = new Map<string, PendingIncident>();
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
    reportIncident(observation) {
      if (incidentListeners.size > 0) {
        for (const listener of incidentListeners) listener(observation);
        return;
      }
      if (observation.kind === 'heartbeat-accepted') {
        const pending = pendingIncidents.get(acceptedHeartbeatKey(observation));
        if (pending !== undefined && pending.incident.kind === 'heartbeat-indeterminate') {
          pending.accepted = observation;
        }
        return;
      }
      const key = incidentKey(observation);
      if (!pendingIncidents.has(key) && pendingIncidents.size === MAX_PENDING_INCIDENTS) {
        const oldest = pendingIncidents.keys().next().value;
        if (oldest !== undefined) pendingIncidents.delete(oldest);
      }
      pendingIncidents.delete(key);
      pendingIncidents.set(key, { incident: observation, accepted: null });
    },
    onIncident(listener) {
      incidentListeners.add(listener);
      for (const pending of pendingIncidents.values()) {
        listener(pending.incident);
        if (pending.accepted !== null) listener(pending.accepted);
      }
      pendingIncidents.clear();
      return () => incidentListeners.delete(listener);
    },
  };
}
