# TODO — project live provider-proxy heartbeat holds into operator status

**Status**: open only across coordinator restart. The lifecycle retains one exclusive `clear | silence |
answered-unusable` window per role and method. An unusable answer replaces silence with answered-unusable
evidence, while an accepted echo or current-tenancy challenge resynchronization clears the window. Silence may end in the
coordinator's bounded `heartbeat_hold_exhausted` stop-and-reap decision. Answered-but-unusable and protocol
incompatibility either await independent containment absence while claims or deadline acceptance remain, or
release a no-claim set to roles whose deadline acknowledgement was verified. The current process projects those
dispositions through `coral-cli backend status`; this entry now concerns only a durable read after that process
dies.

## What exists

`ProviderProxySetLifecycle` keys each live set by its exact `ProviderProxySetIdentity` and keeps active
preservation episodes and the exclusive evidence window in the established slot. Its in-memory status projection retains the set address, role,
method, incident reason, disposition, and current wait. `coral-cli backend status` renders that projection while
the coordinator lives, including a no-claim release after the represented slot has been dropped.

## What is missing

The projection disappears with the coordinator. A replacement coordinator therefore cannot distinguish a stale
hold left by its predecessor from a currently represented set until its own discovery and claim reconciliation
reconstruct the relevant state, and a status request cannot read the predecessor after it is gone. The remaining
work needs a persisted owner and a stale-record rule; it must not make a predecessor's hold appear current merely
because no cleanup write followed a crash.

## What a fix must decide

- Which durable store owns status across coordinator death and restart.
- How a new coordinator distinguishes a stale predecessor record from a currently represented set.
- Whether recovered and released episodes remain bounded history or disappear from the durable projection.

## Start condition

Choose the durable owner and stale-record rule together. The running-process projection is not evidence that a
record survives starvation, crash, or restart.
