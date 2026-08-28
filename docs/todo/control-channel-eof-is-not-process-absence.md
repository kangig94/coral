# TODO — control-channel failure is not process absence

**Status**: implemented on the unreleased branch. The missing exact-set operator exit remains open in
[`operator-shutdown-cannot-reap-a-live-set.md`](./operator-shutdown-cannot-reap-a-live-set.md).

## What is observed

`connectControlClient` reports socket close as `control_client_closed`. It also turns a malformed inbound frame
into an `invalid-frame` remote failure, latches the client fault, and destroys the socket. The authority
observer reports either trigger as a `control-channel-fault` incident with the exact transport cause (`closed`
or `invalid-unattributable-frame`). The terminal-fault union has no channel-loss member, so a channel
observation cannot construct a `stop-and-reap` decision.

The observations are real but narrower than the verdict: one connection ended, either directly or after bytes
on it failed frame validation. Neither establishes that the coordinator process ended, that a replacement
connection cannot be made, or that the work carried by the set is absent.

## Why this is a defect

An ordinary socket close clears the endpoint tenancy before control loss is reported, so authenticated
redemption normally enters successor admission and returns a fresh control epoch. Same-holder reattachment is
only the race where the prior tenancy has not yet been cleared. The terminal latch prevents the coordinator
from attempting either valid outcome after EOF or invalid-frame teardown: the set is routed into containment
as soon as the channel fault arrives. A transient local socket failure can therefore reap healthy provider
work on evidence about the transport rather than evidence about the process or an act by an authority
appointed to override missing evidence.

## What a fix must not do

- It must not reuse the bootstrap nonce. That credential is one-shot, and making it replayable would let an
  old opening mint control again.
- It must not treat an arbitrary reconnect as the prior holder. Reattachment needs a re-provable credential
  bound to the same tenancy; only grant redemption currently has retry semantics strong enough to be a model.
- It must not weaken the endpoint's socket scoping. A heartbeat or mutation from a socket that has not earned
  the tenancy remains a hard refusal.
- It must not turn EOF or an invalid frame into silence. The connection did end; the missing piece is a
  non-destructive disposition and a bounded, authenticated route back to control.

## Implemented disposition

The standing handoff grant is the re-provable credential. A channel incident moves the established slot to
`reattaching`, removes its route immediately, stops the unusable generation's heartbeats, and leaves every
durable claim attached. The window records the first monotonic observation, triggering role and exact cause,
attempts, one absolute adoption-window deadline, and the current attempt token. It is separate from every
heartbeat evidence window.

Each attempt runs authenticated guardian→reaper→proxy redemption beside independent containment proof.
Decisive absence enters the existing disappearance-delivery path. Branded redemption rebuilds the complete
operation authority, invalidates callbacks from the displaced attempt token, subscribes the replacement,
closes the old control, restores `available` or `draining`, restores routing only for `available`, and notifies
establishment so live operations reconcile against newly built controls. A decisive refusal stops redemption
immediately. Refusal and absolute-bound expiry both enter the existing `await-containment-absence` path and do
not initiate destructive action. Unavailability retries only within the original bound; neither a retry nor a
second channel incident moves its deadline.

## Reachable exits and the unsupported one

The reachable exits are authenticated reattachment and combined discharge after independently proven
containment absence plus durable-claim discharge. Independent absence attempts continue without an attempt
limit after refusal or expiry.

There is currently no supported forced exit for a live but unreachable exact set. `coral-cli backend shutdown`
is not one: both operator shutdown transports use `replaced`, which selects handoff and deliberately preserves
the set for a successor. An operator must not be directed to ordinary shutdown to end this hold. Until an
exact-set containment command exists, a peer that remains alive but unreachable can remain represented
indefinitely; the linked tracking entry owns that follow-up.
