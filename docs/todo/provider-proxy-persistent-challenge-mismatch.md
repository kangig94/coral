# TODO — bound persistent heartbeat challenge mismatch

**Status**: open. A `challenge-resynchronized` response proves the current control tenancy answered and therefore
clears the silence hold. It does not prove the peer ever accepted the echoed challenge.

## Why this is separate

The silence hold asks whether the coordinator has evidence about the peer. A mismatch carrying a fresh challenge
answers that question positively. Counting it as silence would authorize containment from evidence that directly
contradicts the hold's subject.

Persistent mismatch asks a different question: whether a peer that keeps answering can nevertheless fail to
complete a heartbeat indefinitely. The proxy role has no enforcer behind that loop. Two independent review
attempts found no persistent loop against the current endpoint, whose mismatch response installs a fresh
challenge for the next echo, so adding a second destructive authority now would prescribe behavior for a state
the correct implementation does not produce.

## Start condition

If a correct endpoint can be shown to repeat mismatch after the coordinator adopts each fresh challenge, define a
separate bounded disposition keyed by set, role, and method. Its evidence and operator status must name repeated
answered-but-unaccepted echoes; it must not reuse `heartbeat_hold_exhausted` or its silence clock.
