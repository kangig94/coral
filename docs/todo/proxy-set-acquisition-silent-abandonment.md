# TODO — a coordinator can abandon provider-proxy acquisition permanently and silently

**Status**: open. Found while investigating why one machine routed every provider operation through a
proxy set on 0.10.6 while another, on the same build, never did.

## The symptom

Two machines, same build, opposite behaviour:

- A freshly installed 0.10.6 routed provider operations through a proxy set.
- A long-lived 0.10.6 coordinator (uptime 1d3h) ran every host coordinator-locally.
  `backend provider-host list` reported `OWNER = coordinator:83afe3f9-…`, never `proxy:…`, and the
  coordinator log contained **no proxy-related line at all** — not even a failure.

Silent divergence is the problem. A coordinator that cannot acquire a proxy set keeps working: every
operation falls back to `local-authorized` at
`src/coordinator/services/provider-proxy-launch-route.ts`, so nothing fails and nothing is reported.
The isolation the proxy exists to provide is simply gone, and no surface says so.

## The mechanism

`ensureProxySetFor` (`src/coordinator/live/provider-hosts/index.ts:334`) drops two of the four
admission outcomes without a word:

```ts
const admission = lifecycle.beginFreshAcquisition(identityKey, { … });
if (admission.kind !== 'accepted') {
  if (admission.kind === 'capacity') {
    backendLog.warn(`Provider proxy set acquisition refused for …`);
  }
  return;                       // startup-discovery-pending and already-represented: no log
}
```

`beginFreshAcquisition` (`src/coordinator/services/provider-proxy-set/index.ts:322-359`) returns
`startup-discovery-pending`, `already-represented`, `capacity`, or `accepted`. Only `capacity` is
reported.

`already-represented` is the one that sticks. It is returned when any slot holds that `routeKey` in
`acquiring`, `available`, `draining`, `containing`, `containment-wait`, or
`absence-delivery-pending`. Of those, only `available` produces a route. So a slot parked in a
containment or drain state puts the coordinator in a state where:

- `routeFor(identityKey)` returns `null`, so every operation takes the local fallback;
- `beginFreshAcquisition` returns `already-represented`, so no new set is ever acquired;
- nothing logs, and nothing retries.

That combination is terminal for the life of the process. `ensureProxySetFor` is only reached from
host acquisition (`:425`) and slot release (`:324`); neither re-runs once the slot is wedged.

`startup-discovery-pending` has the same silence with a narrower window: a host acquired before
`completeStartupDiscovery()` / `installDiscoveredCapsules()` runs is dropped, and nothing re-attempts
acquisition for that entry after discovery completes.

## Why this is worth fixing above its apparent severity

It degrades a safety boundary into an unobserved one. #308 fixed an authority fault that reaped a
whole proxy set while its operations were still executing — exactly the kind of event that can leave
a slot in a containment state. If the reap is now survivable but the _re-acquisition_ is not, the
coordinator quietly stops using the proxy for the rest of its uptime, and the next operator to look
sees a healthy `backend status`.

It also explains machine-to-machine divergence that currently looks like environment weirdness, and
it changes what a bug report means: "works on my machine" can mean "my coordinator gave up on the
proxy hours ago".

## Decision required

Three things, and the second is the actual design question:

1. **Report the silent outcomes.** `already-represented` and `startup-discovery-pending` should be
   observable. A log line is the floor; a `backend status` runtime-component signal is better,
   because the condition persists and a startup-time log scrolls away.
2. **Decide who re-attempts, and when.** Options: re-run `ensureProxySetFor` for live entries once
   startup discovery completes; have slot-state transitions out of containment/drain trigger
   acquisition rather than only `onSlotReleased`; or make `already-represented` carry the blocking
   slot state so the caller can distinguish "a set is coming" from "a set is wedged". The last is the
   most honest — the caller currently cannot tell those apart, which is why it does nothing.
3. **Decide whether a wedged slot should be recoverable at all**, or whether it is a defect that
   should surface as a fault instead of a fallback. Falling back to local is correct for a _transient_
   gap; it is wrong as a permanent unannounced state.

## Verify the hypothesis first

The cheap decisive test was not run because a long job held the daemon: **restart the coordinator on
the affected machine** and re-check `backend provider-host list`. A fresh process has empty slots, so
if `OWNER` becomes `proxy:…` the wedged-slot explanation is confirmed and the work is re-acquisition,
not acquisition. If it stays `coordinator:…`, the cause is earlier — look at
`completeStartupDiscovery()` and whether `proxySetAcquisition` is configured on that path at all.

Capture `backend provider-host inspect <ref>` before and after; the affected host showed
`generation: 80`, so respawn history may be relevant.

## Explicitly out of scope

This item does not change the local-authorized fallback itself, the proxy control protocol, the
containment model, or #308's authority-fault classification. It is about acquisition being abandoned
without a signal and without a retry.

## Start condition

Begin after the restart experiment above settles whether this is a re-acquisition failure or an
initial-acquisition failure. The implementation must include a test that wedges a slot in a
containment state and asserts the coordinator either re-acquires or reports, rather than silently
serving `local-authorized` forever.
