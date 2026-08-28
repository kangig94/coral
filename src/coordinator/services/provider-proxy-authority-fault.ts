import type { ControlClient, ControlClientError } from '../../provider-proxy/control-client.js';
import type { HeartbeatObservation } from '../../provider-proxy/heartbeat-observation.js';
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
 *  could not construct or send a heartbeat call at all, so nothing about the peer was ever in question. */
export type ProviderProxyHeartbeatTerminalReason = 'teardown-latched' | 'local-failure';

export type ProviderProxyControlChannelCause = 'closed' | 'invalid-unattributable-frame';

export type ProviderProxyControlChannelIncident = Readonly<{
  kind: 'control-channel-fault';
  role: ProviderProxyRole;
  cause: ProviderProxyControlChannelCause;
  error: ControlClientError;
}>;

export type ProviderProxyAuthorityFault =
  | Readonly<{
      kind: 'operation-control-failed';
      policy: ContainmentRequiredControlCallPolicy;
      error: unknown;
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
  | ProviderProxyControlChannelIncident
  | ProviderProxyHeartbeatObservation;

export type ProviderProxyHeartbeatObservation = Readonly<{
  kind: 'heartbeat-observation';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  observation: HeartbeatObservation;
  schedulerLatenessMs: number;
}>;

/** Nothing delivered on this channel may consume terminal fault state. */
export type ProviderProxyAuthorityObservation = ProviderProxyAuthorityIncident;

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
  accepted: ProviderProxyHeartbeatObservation | null;
};

function incidentKey(incident: ProviderProxyAuthorityIncident): string {
  switch (incident.kind) {
    case 'heartbeat-observation':
      return JSON.stringify([incident.role, incident.method]);
    case 'control-channel-fault':
      return JSON.stringify([incident.kind, incident.role]);
    case 'operation-control-failed':
      return JSON.stringify([incident.kind, incident.policy.method]);
  }
}

export function providerProxyControlChannelIncident(
  role: ProviderProxyRole,
  error: ControlClientError,
): ProviderProxyControlChannelIncident {
  if (error.origin === 'closed') return { kind: 'control-channel-fault', role, cause: 'closed', error };
  if (error.origin === 'remote-response' && error.remoteFailure?.kind === 'invalid-frame') {
    return { kind: 'control-channel-fault', role, cause: 'invalid-unattributable-frame', error };
  }
  throw new Error('provider_proxy_control_channel_incident_cause_missing');
}

function isAcceptedHeartbeat(
  observation: ProviderProxyAuthorityObservation,
): observation is ProviderProxyHeartbeatObservation {
  return (
    observation.kind === 'heartbeat-observation' &&
    observation.observation.kind === 'reply' &&
    observation.observation.reply.kind === 'accepted'
  );
}

export function createProviderProxyAuthorityFaultLatch(): ProviderProxyAuthorityFaultLatch {
  let resolveFault!: (fault: ProviderProxyAuthorityFault) => void;
  let latchedFault: ProviderProxyAuthorityFault | null = null;
  const listeners = new Set<(fault: ProviderProxyAuthorityFault) => void>();
  const incidentListeners = new Set<(observation: ProviderProxyAuthorityObservation) => void>();
  // The key vocabulary is build-owned, so overwriting the pending observation cannot grow this map from
  // runtime input.
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
  const reportIncident = (observation: ProviderProxyAuthorityObservation): void => {
    if (incidentListeners.size > 0) {
      for (const listener of incidentListeners) listener(observation);
      return;
    }
    if (isAcceptedHeartbeat(observation)) {
      const pending = pendingIncidents.get(incidentKey(observation));
      if (pending !== undefined && pending.incident.kind === 'heartbeat-observation') {
        pending.accepted = observation;
      }
      return;
    }
    const key = incidentKey(observation);
    pendingIncidents.delete(key);
    pendingIncidents.set(key, { incident: observation, accepted: null });
  };
  return {
    faulted,
    observeControlClient(role, client) {
      client.onFault((error) => reportIncident(providerProxyControlChannelIncident(role, error)));
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
    reportIncident,
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
