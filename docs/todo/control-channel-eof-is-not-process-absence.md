# TODO — control-channel failure is not process absence

**Status**: implemented on the unreleased branch, including the exact-set operator exit
`coral-cli backend provider-proxy-set contain <pps1-token>`.

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
  non-terminal disposition and a bounded, authenticated route back to control. The disposition may reap the
  proxy group only after both enforcers are independently proven absent, when the group is an orphan rather
  than work still owned by a reachable enforcer.

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
immediately. Refusal and absolute-bound expiry both enter the existing `await-containment-absence` path without
sending `stopAndReap`. Unavailability retries only within the original bound; neither a retry nor a second
channel incident moves its deadline. The independent proof returns while either enforcer may still be live. Once
guardian and reaper are both proven absent, it reaps the orphaned proxy group: that ends work no reachable
enforcer can ever reap rather than pre-empting a live owner.

## Reachable exits

The reachable exits are authenticated reattachment and combined discharge after independently proven
containment absence plus durable-claim discharge. Independent absence attempts continue without an attempt
limit after refusal or expiry.

`coral-cli backend provider-proxy-set contain <pps1-token>` is the supported exact-set operator exit. The token
comes from `backend status`. A `reattaching` hold refuses it until that hold's recorded monotonic adoption-window
deadline. A fault-driven `containing` or `containment-wait` hold instead refuses it for the fixed 30-second
containment-attempt observation span that started when containment began; a longer configured adoption window
does not extend that gate. Confirmed recorded-set absence uses the ordinary evidence-backed disappearance path.
An observed-live or unobservable enforcer is a refusal until the operator supplies `--abandon-unobservable`
after external verification; that releases Coral's representation without asserting process absence. An
unreadable local durable row is non-overridable and must be repaired through `backend recovery-quarantine`.

`coral-cli backend shutdown` remains intentionally different: both shutdown transports use `replaced`, select
handoff, and preserve the set for a successor. Its best-effort pre-shutdown status read names every set whose
token decoded and gives its exact contain command; when that read fails or skips a row, shutdown says it could
not establish that the list is complete. Shutdown's reason and exit contract do not change. Forced containment
signals the recorded proxy process group plus every recorded provider root for that set that is observed
present. Guardian and reaper are not signalled and may remain live until their own adoption deadline.
