import type { ProviderProxySetEnforcerObservations } from './containment-proof-contract.js';
import type { ProviderProxySetAddress } from './set-address.js';

/** Transport must not import coordinator modules. */
export const PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS = [
  'held',
  'awaiting-containment-absence',
  'operator-exit-refused',
] as const;
export type ProviderProxySetOperatorDispositionKind = (typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS)[number];

export const PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES = ['closed', 'invalid-unattributable-frame'] as const;
export type ProviderProxySetOperatorDispositionCause = (typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES)[number];

export const PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR = [
  'heartbeat-evidence-window',
  'control-reattachment',
  'independent-containment-absence',
  'ordinary-drain',
  'set-adoption-deadline',
  'operator-abandonment',
  'store-repair',
  'publication-confirmation-or-control-release',
  /** Must exit through active-control retry, confirmed absence, accepted succession, or operator override. */
  'containment-authorization',
  /** Must exit through active-control retry, confirmed absence, accepted succession, or operator override. */
  'containment-outcome-unknown',
  /**
   * Must preserve routing and heartbeats until an accepted heartbeat, zero claims, explicit containment, or
   * representation-only abandonment.
   */
  'heartbeat-bound-live-claims',
  /**
   * Must preserve claims until redeemed control, confirmed absence, explicit containment, or
   * representation-only abandonment.
   */
  'control-reattachment-bound-live-claims',
  /**
   * Must retain claims and routing until compatible control, zero claims, explicit containment, or
   * representation-only abandonment.
   */
  'heartbeat-protocol-live-claims',
  /**
   * Must retain claims and reconciliation ownership until control recovery, zero claims, explicit containment,
   * or representation-only abandonment.
   */
  'operation-control-outcome-unknown',
] as const;
export type ProviderProxySetOperatorDispositionWaitingFor =
  (typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR)[number];

export const PROVIDER_PROXY_SET_OPERATOR_EXIT_KINDS = ['none', 'gated', 'contain', 'abandon', 'refused'] as const;
export type ProviderProxySetOperatorExitKind = (typeof PROVIDER_PROXY_SET_OPERATOR_EXIT_KINDS)[number];

export const PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS = [
  'enforcer-alive',
  'enforcer-unobservable',
  'recorded-group-unattributable',
  'signal-authorization-refused',
  'identity-unobservable',
  'store-unreadable',
  'representation-release-fatal',
] as const;
export type ProviderProxySetOperatorExitRefusalGround =
  (typeof PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS)[number];

export type ProviderProxySetOperatorExit =
  | Readonly<{ kind: Extract<ProviderProxySetOperatorExitKind, 'none'> }>
  | Readonly<{ kind: Extract<ProviderProxySetOperatorExitKind, 'gated'>; remainingMs: number }>
  | Readonly<{ kind: Extract<ProviderProxySetOperatorExitKind, 'contain'> }>
  | Readonly<{ kind: Extract<ProviderProxySetOperatorExitKind, 'abandon'> }>
  | Readonly<{
      kind: Extract<ProviderProxySetOperatorExitKind, 'refused'>;
      ground: ProviderProxySetOperatorExitRefusalGround;
    }>;

export type ProviderProxySetOperatorDisposition = Readonly<{
  disposition: ProviderProxySetOperatorDispositionKind;
  role?: string;
  method?: string;
  cause?: ProviderProxySetOperatorDispositionCause;
  attempts?: number;
  elapsedMs?: number;
  boundMs?: number;
  enforcerObservations?: ProviderProxySetEnforcerObservations;
  incidentReason: string;
  waitingFor: ProviderProxySetOperatorDispositionWaitingFor;
  durableObservation?:
    | Readonly<{
        kind: 'stale';
        writerIncarnation: string;
        reobserveAction:
          | 'automatic-exact-set-containment-observation'
          | 'automatic-exact-acquisition-containment-observation';
      }>
    | Readonly<{
        kind: 'current-writer';
        writerIncarnation: string;
      }>
    | Readonly<{
        kind: 'successor-observed';
        writerIncarnation: string;
        observedByIncarnation: string;
      }>;
}>;

export type ProviderProxySetOperatorStatus = Readonly<{
  setIdentity: ProviderProxySetAddress;
  setToken: string;
  liveClaims: number;
  operatorExit: ProviderProxySetOperatorExit;
  holds: readonly ProviderProxySetOperatorDisposition[];
}>;

export type ProviderProxySetDurableDispositionSkipStatus = Readonly<{
  key: string;
  setToken: string | null;
  unavailableAction: 'reconciliation-and-retirement';
}>;
