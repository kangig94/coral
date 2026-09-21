# A representation release retries every second, forever

**Status**: narrowed, not closed. What is gone is the *logged* loop, the unbounded hold on a representation
slot, and the durable write on every failed re-attempt. The re-attempt itself is unbounded by design and says
what it is waiting for through the release disposition. What survives is the classification behind it: a
deterministic terminalization failure is still retried as if it were transient. See *What this does not
settle*.

## What was seen

`~/.coral/gen2/run/coordinator.log.1`, a 10 MB rotated log, contained 72,641 copies of

```
WARN Provider proxy lifecycle containment-retry woke 1ms after its requested time.
```

out of 82,688 lines — 88% of the file. The first is stamped `2026-09-17T05:20:11Z` and the last
`2026-09-18T10:00:16Z`: **one retry per second for over 28 hours**, ending only because the process died.

It also survives restart. After a full teardown — coordinator shut down gracefully, guardian, reaper and
proxy killed, socket and discovery record gone — a cold boot logged `Running on 127.0.0.1:<port>` and the
first `containment-retry` line **one second later**. The loop is therefore rebuilt from durable
provider-proxy set state on every boot, not held in memory by one unlucky instance, which is why 28 hours
of it spanned more than one coordinator.

## Why it did not stop

`#scheduleRepresentationReleaseRetry` (`ProviderProxySetLifecycle`,
`src/coordinator/services/provider-proxy-set/index.ts`) schedules a fixed 1,000 ms timer that calls
`#deliverRepresentationRelease` and, on another unavailable-consumer outcome, schedules itself again.
There is no attempt counter anywhere on that path — `deliveryRetryTimers` holds one timer per operation
key and nothing counts how many times a key has been rescheduled. Its only non-success exits are
`slot.fatalSettlement !== null` and slot teardown, so a consumer that is permanently unavailable —
`representation_abandonment_consumer_unavailable` — produces an unbounded loop.

Principle 11 of [`design-philosophy`](../../.claude/rules/design-philosophy.md): *"a bounded retry is not
by itself an exit — exhausting it must reach a named successor, not the same hold."* This one is not even
bounded, so there is nothing to exhaust. Principle 12 is what makes it matter: nobody is watching, so
nothing was going to notice 28 hours of it.

## Resolution

Representation delivery keeps its 1,000 ms retry cadence, and the 60,000 ms settlement window is now armed once
against the slot when release begins rather than recomputed from each delivery outcome. The earlier shape
consulted the window only after a delivery failed or a retry timer woke, so a delivery that never settled at all
never reached it; the deadline now expires either way.

Expiry releases the **slot**, which is capacity rather than an obligation: `#removeRepresentationSlot` frees a
`MAX_COORDINATOR_PROXY_SET_SLOTS` slot, the mutation fence, the route, and the in-memory operator dispositions,
and the hold settles as `released-undischarged` — a variant of the settlement type, not a success carrying a
field. Its one `witness` field is derived from what is still outstanding at the bound: the provider-operation
record while an operation is pending, the handoff capsule when none is.

`reconcile` (`ProviderOperationReconciler`) re-attempts a latched notice whose delivery is not in flight. That
is the exit for the record witness: the released slot cleared its delivery retry timer, so nothing else was
going to try again. The attempt is started and not awaited, because a due turn has to finish whether or not a
delivery settles.

Failed release deliveries do not write the provider-operation record. The attempt's retry-safe disposition is
already decided before any bookkeeping could run, and a held SQLite write lock can refuse both terminalization
and an accounting write. Letting the second refusal escape converted the decided retry into an `unknown`
consumer rejection and a fatal representation release. Catching it while also reporting it once and making
the next attempt distinguishable would require another state bit; deleting the bookkeeping removes that axis.

The same deletion removes the cause-alternation log flood, the durable commit on every permanent failure, and
the false host-refusal pairing of an incremented `retryCount` with preserved older `lastError` evidence. Entry
into the failing state is already the slot's `operational-retry-owned` initial disposition, which carries the
terminalization cause forwarded through the dispatcher. The distinct 60-second outcome is the
`released-undischarged` transition. Individual re-attempts do not emit another event merely because their
cause changed.

While the representation slot exists, its one-second timer preserves the common case where contention clears
within seconds. After the slot bound, the reconciler's two-second poll re-drives the latched notice without a
durable write. Widening `retryDelayMs` is therefore not a parameter change for this path: it is shared by every
ordinary provider-operation retry and no longer paces released-slot delivery. Giving release a separate
backoff would require new release-attempt state, so this correction does not add one.

The earlier resolution wrote
`operator_exit_representation_release_retry_exhausted` into the durable operator-disposition store and named
`durable-representation-release-reconciliation` as the successor. Both were wrong: that row is written as
`current-writer`, and the reconciler and its scheduler select only `stale` and non-canonical `successor-observed`
rows, so the writing process never reconciles its own row; and the successor that *would* eventually read it,
`#retireDurableSetDispositionsAfterContainmentAbsence`, retires the **row** and never terminalizes the
**operation**. The CLI's "no command is required: durable representation-release reconciliation owns the
remainder" was therefore false. The row, the refusal ground, the durable-write retry, and that CLI line are gone.

## Corrections to this branch's resolution

The first is the round-100 correction to the mechanism itself. The remainder are false sentences in published
history, recorded here because a reader meets this file and not a commit body, and because one of them reads
as a licence to delete a guard.

**Per-attempt accounting was not a status surface; it was a second failure path.** The row already witnesses
the outstanding operation, while the release disposition reports that delivery is failing. Writing the
delivery attempt into `revision`, `retryCount`, `retryNotBeforeMs`, and `lastError` made a lock refusal fatal,
logged alternating causes forever, committed forever, and paired host-refusal evidence with a count about a
different subject. `#recordReleaseAttempt` and its cause-comparison helper are deleted. The row now changes
only when provider-operation reconciliation changes it, not when release delivery fails around it.

**`28115ec6` says "the `currentDelivery` guard is not what defends a released slot". It is.**
`#releaseUndischargedRepresentation` sets no `terminalSettlement` and clears no `pendingOperations`, so of
`currentDelivery`'s three clauses only slot identity refuses a delivery outcome arriving after that release.
Removing it would let the retry sink arm a 1,000 ms timer on a slot `#clearRepresentationReleaseTimers` will
never run against again (the loop this entry exists to close), and let the fatal sink write a durable
operator-exit-refused row for an identity whose slot is gone, resurrecting the record
`#removeRepresentationSlot` had just deleted. Both are pinned by the two `refuses a … delivery whose
representation slot was already released undischarged` tests: deleting the clause turns both red.

**The correction above was itself imprecise, and `0a4ede46` acted on the imprecision.** "The `retry` and
`fatal` sinks are re-checked nowhere downstream" is true and irrelevant — nothing downstream needs to
re-check, because all three sinks evaluate `currentDelivery()` synchronously at the call site before invoking
their handler. `0a4ede46` read that clause as a gap and gave `#retainRepresentationRelease` and
`#failRepresentationRelease` a head guard repeating `currentDelivery`'s first clause; its own commit message
says the two sinks "were defended by nothing downstream", which is false in the only sense that matters. Both
head guards were unreachable — each method is `#`-private with exactly one caller — and the mutation table in
that round already showed it: deleting only the `currentDelivery` clause left the suite green *because the
head guards closed it*. The guards are deleted, and `currentDelivery` is the one place the predicate lives.

**The same commit's constraint comment claimed more than can be checked, and the claim is measurably
over-strong.** It said all three `currentDelivery` clauses are load-bearing and none subsumes the others.
Measured against the whole unit suite with the head guards gone: dropping the slot-identity clause alone
turns two tests red; dropping `terminalSettlement === null` alone leaves 8,272 tests green; dropping the
`pendingOperations` membership clause alone leaves them green; dropping both of those together turns one
test red (`tests/unit/jobs/shell/launch.test.ts`). Tracing why: on a fatally settled slot the retry sink's
whole effect is refused again downstream (`#scheduleRepresentationReleaseRetry` early-returns on
`terminalSettlement`, and `#finishInitialDisposition` meets an already-rejected latch), and the fatal sink's
is too (`#settleFatalRepresentationRelease` returns the existing settlement). The only consequence the
`terminalSettlement` clause uniquely prevents is the evidence sink deleting from `pendingOperations` on a
slot that has already settled, and nothing observes that. So the clauses are kept — each is cheap and
argued reachable — but the comment asserting three independent load-bearing clauses is gone, replaced by
the one clause a test actually proves. Do not restore the stronger claim without a case for each clause
that a test can see.

**`28115ec6`'s account of why the due poll could not re-drive a stranded record is wrong, though its
conclusion held.** It says `acquireAuthority` reaches `containmentAbsent` with no slot and throws. It never got
that far: `reconcile` short-circuited on the latched disappearance (`case 'ready': return Promise.resolve()`)
before any authority lookup, so there was no throw, no WARN, and no loop — a silent permanent park, which on a
machine with nobody watching is worse than the flood. Re-minting the recovering slot on the live path was
considered and rejected: `#occupiedSlotCount` counts every non-`capsule-foreign` slot, so a re-minted
`recovering` slot re-occupies one of the four the bound exists to free. Consuming the notice needs no slot, so
the re-attempt runs through the consumer instead.

## What this does not settle

`ProviderOperationTerminalizationUnavailableError` was never constructed anywhere in `src/`, so the only route
into `disappearance_consumer_unavailable` is `ProviderOperationAtomicTerminalizationError`, which wraps every
non-journal throw from inside the synchronous `store.commit` closure and is classified `retry-safe-unknown`. The
dead error has been deleted, but the classification is unchanged: a deterministic throw — a schema rejection of
the terminal payload, a bad ref — is still retried at 1 Hz, now for 60 seconds instead of forever.

Splitting that classification needs a fact `terminalizeProviderOperation` cannot observe. `withImmediate`
(`src/store/db.ts`) runs `BEGIN IMMEDIATE`, the closure, then `COMMIT`, and rolls back on any throw; from outside
the `try` there is no way to tell a closure throw (decisive: nothing was written) from a `COMMIT` throw
(indeterminate). Tagging it means changing `withImmediate` or `commit`. And "decisive rollback" is not the same
as "deterministic": `SQLITE_BUSY` after the configured `busy_timeout` is decisive *and* transient, so treating
every decisive rollback as a non-retryable refusal would make ordinary lock contention a fatal representation
release. Both ends of that trade-off are defects, which is the signature of an axis
(see [`review-loop-dynamics`](../review-loop-dynamics.md)); it needs a construction where the store reports which
stage failed, not a choice between the two ends.
