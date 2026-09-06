import type { ProviderProxySetEnforcerObservations } from './containment-proof-contract.js';
import type { ProviderProxySetAddress } from './set-address.js';

/**
 * Transport may not import coordinator modules: the coordinator composes transport, so the reverse import
 * closes the coordinator-transport cycle. Keep their shared operator-disposition vocabulary below both layers.
 */
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
  /** The guardian commit was proven not to have latched: a local `not-sent` result, or a structured
   *  pre-commit refusal. Exits: a current active-control retry, decisive holder/containment absence,
   *  accepted successor, or the operator override. */
  'containment-authorization',
  /** The guardian commit may have reached the guardian and its response was lost. Exits are the same as
   *  `containment-authorization`'s — this subject differs only in what it asserts happened, never in what
   *  ends it. */
  'containment-outcome-unknown',
  /** A silence- or answered-unusable-exhausted heartbeat window with live claims present. Neither is
   *  decisive, so the route and heartbeat loop keep running. Exits: an accepted heartbeat, `liveClaims`
   *  reaching zero and ordinary drain, explicit operator containment, or representation-only abandonment. */
  'heartbeat-bound-live-claims',
  /** A control-reattachment bound expiry, a non-decisive redemption refusal, or a `heartbeat-failed`
   *  `local-failure` fault, all with live claims present — this coordinator's own failure to reach the peer,
   *  never a disposition about it. Exits: redeemed control, decisive absence, explicit operator containment,
   *  or representation-only abandonment. */
  'control-reattachment-bound-live-claims',
  /** A `method-not-found` heartbeat reply with live claims present: the peer answered, but not with a
   *  protocol this build can use. Claims and routing are retained; only this role's heartbeat is marked
   *  unavailable. Exits: compatible control, `liveClaims` reaching zero, explicit operator containment, or
   *  representation-only abandonment. */
  'heartbeat-protocol-live-claims',
  /** An indeterminate `operation-control-failed` mutation with live claims present. The route is removed and
   *  no further mutation is dispatched, but claims and reconciliation ownership are retained. Exits:
   *  control/status recovery, `liveClaims` reaching zero, explicit operator containment, or
   *  representation-only abandonment. */
  'operation-control-outcome-unknown',
] as const;
export type ProviderProxySetOperatorDispositionWaitingFor =
  (typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR)[number];

export type ProviderProxySetOperatorExit =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'gated'; remainingMs: number }>
  | Readonly<{ kind: 'contain' }>
  | Readonly<{
      kind: 'refused';
      ground:
        | 'enforcer-alive'
        | 'enforcer-unobservable'
        | 'recorded-group-unattributable'
        | 'signal-authorization-refused'
        | 'identity-unobservable'
        | 'store-unreadable'
        | 'representation-release-fatal';
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
}>;

export type ProviderProxySetOperatorStatus = Readonly<{
  setIdentity: ProviderProxySetAddress;
  setToken: string;
  liveClaims: number;
  operatorExit: ProviderProxySetOperatorExit;
  holds: readonly ProviderProxySetOperatorDisposition[];
}>;
