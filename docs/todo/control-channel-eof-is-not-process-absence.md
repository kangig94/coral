# TODO — control-channel failure is not process absence

**Status**: open. Deliberately split from the deadline/silence fix: repairing it needs a credential that can
prove the same holder again after its control channel has failed.

## What is observed

`connectControlClient` reports socket close as `control_client_closed`. It also turns a malformed inbound frame
into an `invalid-frame` remote failure, latches the client fault, and destroys the socket. The authority fault
latch records either trigger as `control-channel-fault`, and provider-proxy set policy treats that as a terminal
fault that authorizes `stop-and-reap`, including while durable claims remain live.

The observations are real but narrower than the verdict: one connection ended, either directly or after bytes
on it failed frame validation. Neither establishes that the coordinator process ended, that a replacement
connection cannot be made, or that the work carried by the set is absent.

## Why this is a defect

`createControlEndpoint` already has `reattachControl` for the same holder returning on another socket. The
terminal latch prevents the coordinator from using that recovery shape after EOF or invalid-frame teardown:
the set is routed into containment as soon as the channel fault arrives. A transient local socket failure can
therefore reap healthy provider work on evidence about the transport rather than evidence about the process or
an act by an authority appointed to override missing evidence.

## What a fix must not do

- It must not reuse the bootstrap nonce. That credential is one-shot, and making it replayable would let an
  old opening mint control again.
- It must not treat an arbitrary reconnect as the prior holder. Reattachment needs a re-provable credential
  bound to the same tenancy; only grant redemption currently has retry semantics strong enough to be a model.
- It must not weaken the endpoint's socket scoping. A heartbeat or mutation from a socket that has not earned
  the tenancy remains a hard refusal.
- It must not turn EOF or an invalid frame into silence. The connection did end; the missing piece is a
  non-destructive disposition and a bounded, authenticated route back to control.

## Start condition

Choose and implement a re-provable same-holder credential for bootstrap tenancies, including its replay and
cross-build rules. Once a replacement socket can prove continuity without reopening the bootstrap nonce,
route `control-channel-fault` through a hold that ends on authenticated reattachment, decisive containment
absence, the enforcer's adoption/teardown act, or `coral-cli backend shutdown`.
