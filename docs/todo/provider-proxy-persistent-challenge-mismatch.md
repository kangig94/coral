# TODO — bound persistent heartbeat challenge mismatch

**Status**: open. A `challenge-resynchronized` response proves the current control tenancy answered and therefore
clears both heartbeat holds. It does not prove the peer ever accepted the echoed challenge.

## Why this is separate

The silence hold asks whether the coordinator has evidence about the peer. A mismatch carrying a fresh challenge
answers that question positively. Counting it as silence would authorize containment from evidence that directly
contradicts the hold's subject.

Persistent mismatch asks a different question: whether a peer that keeps answering can nevertheless fail to
complete a heartbeat indefinitely. Against same-build peers, the population is empty for a stronger reason
than challenge rotation alone: every path that clears a control tenancy also destroys that tenancy's socket,
both displacement paths destroy the displaced socket, heartbeat dispatch precedes the unauthorized-control
check, and `echoChallenge` validates the reply with the caller's strict result schema. A peer with no tenancy
therefore cannot retain a live socket that keeps answering, while a peer with a live tenancy either returns an
accepted echo or the one fresh mismatch challenge.

Cross-build peers can remain answered-but-unusable because an older coordinator may reject an evolved reply
shape or receive `method_not_found`. Those states now have explicit non-reaping release dispositions:
`heartbeat_answer_unusable_hold_exhausted` after its own hold, and immediate
`heartbeat_protocol_incompatible`. The remaining subject here is narrower: whether cross-build challenge
semantics can produce a persistent sequence of accepted fresh challenges that never completes an echo.

## Start condition

If cross-build endpoints can be shown to repeat mismatch after the coordinator adopts each fresh challenge,
decide whether that sequence belongs in the existing answered-but-unusable disposition or needs a separate
non-reaping one. Its evidence and operator status must name repeated answered-but-unaccepted echoes; it must not
reuse `heartbeat_hold_exhausted` or its silence clock.
