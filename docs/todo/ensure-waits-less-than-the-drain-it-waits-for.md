# TODO — ensure waits less than the drain it waits for

**Status**: open. This work is not implemented. It was split from Track B of kangig94/coral#357 after both
final-round reviewers independently recommended separating coordinator reporting from later-invocation
replacement behavior, and the owner accepted that recommendation.

## The mismatch

`prepareTopLevelSpawn` calls `waitForSocketRelease` with the transport-local
`HANDOFF_DRAIN_TIMEOUT_MS` (`src/transport/ipc/ensure.ts`), so a draining incumbent gets 30,000 ms to release
the address before `CoordinatorSocketReleaseTimeout`. Phase 1 measured the production handoff drain's own
scheduled boundary at approximately 60 seconds — **60,100 ms** at that boundary. The waiter can therefore
time out in half the time the drain it is waiting for is allowed to take.

That 30-second constant is copied for more than one purpose. `drainBoundedClient` in the same module uses it
as a request cap for a command already issued to a draining coordinator; that cap is not the socket-release
wait and must not be changed accidentally with it. Separately, `createLifecycle`
(`src/coordinator/lifecycle.ts`) passes the coordinator's `HANDOFF_DRAIN_TIMEOUT_MS`
(`src/coordinator/shutdown.ts`) to `bindWithHandoff` (`src/coordinator/handoff.ts`) as `totalBudgetMs`, so the
successor also has a copied handoff budget that must be assessed explicitly rather than assumed equivalent to
the drain's terminal bound.

## Why consuming `boundMs` naively is wrong

The reported `boundMs` bounds the ledger's scheduled work, not address release or process liveness. In
`createLifecycle` (`src/coordinator/lifecycle.ts`), a failure in the scheduled shutdown continuation is logged
and swallowed; no replacement continuation is scheduled. The ledger's bound can then reach zero while the
drain remains live and the incumbent continues to retain its IPC socket indefinitely.

Treating `observedAt + boundMs` as a release deadline would reproduce the same defect with a larger number:
the later invocation would time out while the coordinator it projected is still draining. Repairing the
counterexample by guaranteeing another continuation, or by ending the coordinator when its own loop cannot
make progress, reaches the deliberately separate
[`wedged-coordinator-self-drain`](./wedged-coordinator-self-drain.md) question.

The earlier reason for keeping this change in Track B was that it would make `boundMs` load-bearing. That
reason is refuted. Track B's live renderer prints the value, and its drain guidance changes when the value is
zero versus positive, so the field already has observable consumers without changing `ensure`.

## Contract to design

The honest terminal condition is **observed address turnover**, not a scheduled deadline. A replacement wait
may use the reported bound as an observation checkpoint, but elapsed time alone cannot authorize a spawn or a
timeout while the same incumbent may still own the address. It must distinguish at least:

- the address becoming bindable;
- a different coordinator instance serving the address; and
- the original incumbent possibly still owning it, including after `boundMs` reaches zero or health stops
  answering.

The third answer can wait indefinitely. Closing that exit requires an explicit self-drain or external
supervision decision; it cannot be smuggled into a deadline consumer.

The process-level release test that moved with this work may need control over the bootstrap probe-cleanup
deadline in `createBootstrapProbeExitGate` (`src/coordinator/bootstrap.ts`). Any constant exposure or move for
that fixture belongs here only if the follow-up still needs it; the reporting phases have no consumer for it.

## Start condition

Design the address-turnover observation and decide how a wedged incumbent is allowed to end before replacing
the 30-second release wait. Tests must include the failed-continuation counterexample and must prove that a
zero reported bound does not by itself permit timeout, spawn, or replacement.
