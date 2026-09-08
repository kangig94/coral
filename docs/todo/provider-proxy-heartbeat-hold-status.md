# Provider-proxy hold status across coordinator death

**Status**: implemented. There is no remaining ownership or staleness decision in this entry.

## Durable ownership

Set-scoped heartbeat preservation dispositions and acquisition-cleanup holds are durable records owned by
`ProviderProxySetOperatorDispositionStore` (`src/coordinator/services/provider-proxy-set/operator-disposition-store.ts`).
The records contain validated process and set identities and carry the coordinator writer's instance identity.
`ProviderProxySetLifecycle` receives that owner as a dependency; the durable shape stays in provider-proxy
vocabulary rather than becoming a Journal record.

Set and acquisition updates share one generation-addressed artifact. Replacing records and retiring their
predecessor keys is one durable atomic write. An unreadable artifact, a refused write, or an unconfirmed write
returns a hold with `waitingFor: 'store-repair'` and the
`provider-proxy-set-operator-disposition-store-retry` exit; it never reports the disposition as recorded.

## Successor rule

A record from another writer is predecessor evidence, never current authority. Before durable lifecycle
authority is activated, the successor marks those set and acquisition records stale in memory and attempts
to publish that classification atomically. A failed publication retains the store-repair hold and schedules
reconciliation rather than promoting predecessor evidence to authority. Reconciliation observes the exact
recorded subject:

- confirmed absence permits retirement;
- observed live or unobservable containment remains a durable hold with the successor's observation;
- a store failure preserves the hold and retries through the named store-repair exit;
- a record whose shape or identity key cannot be validated is reported as skipped and cannot be reconciled or
  retired by that build.

The same rule applies to a heartbeat-derived set disposition and an acquisition-cleanup disposition. A
successor cannot promote either predecessor record to authority or infer absence from a failed observation.

## Retention

A durable set disposition is retired only after exact containment absence or explicit operator abandonment.
An acquisition disposition is retired only by matching acquisition-absence evidence or explicit operator
abandonment. Until then, the lifecycle snapshot retains the obligation and its available exit.

The heartbeat exchange itself is not an event stream. The durable contract preserves the resulting evidence
window and operator disposition, which is the lifecycle obligation that must survive coordinator death.

The jobs and provider-proxy domains keep separate durable hold vocabularies. A unified cross-domain hold store
would erase owner-specific evidence and violate the store/provider-proxy boundary.
