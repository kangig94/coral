# TODO — project live provider-proxy heartbeat holds into operator status

**Status**: open. The lifecycle now retains a heartbeat hold until that exact role supplies liveness evidence
(an accepted echo or current-tenancy challenge resynchronization) *or* the coordinator's own bounded escalation (`heartbeatHoldBound`, `#escalateHeartbeatHold` in
`provider-proxy-set/index.ts`) ends it, but the state is coordinator-local and no existing command reads it —
this entry is about the read path, not the exit, which the escalation now supplies.

## What exists

`ProviderProxySetLifecycle` keys each live set by its exact `ProviderProxySetIdentity` and keeps active
preservation episodes in the established slot. Lifecycle logs carry the set reference, role, method, reason,
and recovery transition. They are an event history, not a current-status read: `snapshot()` is test-only, and
`coral-cli backend status` has no projection of the lifecycle's active holds.

## What is missing

Principle 11 requires a refusal or hold to remain readable as current status under the identity an operator can
act on. Satisfying that requires a persisted owner, not another log field. The projection must be keyed by the
complete provider-proxy set identity, publish the active heartbeat role/method and incident reason, and remove
that exact entry only after role liveness evidence or the set's terminal lifecycle transition.

The reader should be an existing command. The default candidate is `coral-cli backend status`, because it
already composes coordinator availability with durable local status; `backend provider-host inspect` is keyed
by a host rather than a proxy set and cannot represent more than one set without changing its subject.

## What a fix must decide

- Which durable store owns live set status across coordinator death and restart.
- How a new coordinator distinguishes a stale hold left by its predecessor from a currently represented set.
- Whether recovered episodes remain bounded history or disappear from the current projection.
- How `backend status` renders multiple held roles without losing the exact set identity needed for shutdown or
  support action.

## Start condition

Choose the durable owner and stale-record rule together. Do not add a CLI field backed only by the current
process's memory: the status command must remain useful when that process is the thing that is starved or gone.
